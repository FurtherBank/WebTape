'use strict';

/**
 * WebTape 插件层采集规则 — 集中管理
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 边界说明                                                           │
 * │                                                                     │
 * │ 插件层（本文件）  → 控制「采集什么」                               │
 * │   哪些网络请求要录制、哪些用户操作要捕获、时间窗口参数、           │
 * │   A11y 树过滤等。                                                   │
 * │                                                                     │
 * │ 接收层（packages/webtape-cli/src/rules.ts）→ 控制「如何呈现」 │
 * │   导出 JSON / context 综述时的头过滤、body 截断、协议过滤、        │
 * │   时间线加工等。                                                    │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * 加载方式：
 *   - background.js  →  importScripts('rules.js')
 *   - content.js     →  manifest.json content_scripts 列表中前置加载
 */

// eslint-disable-next-line no-unused-vars
const WebTapeRules = (() => {

  // =========================================================================
  // 1. Request Capture — 决定哪些网络请求要被录制
  // =========================================================================

  /** CDP 资源类型白名单，只录制 API / 数据请求 */
  const ALLOWED_RESOURCE_TYPES = new Set([
    'XHR', 'Fetch', 'WebSocket', 'EventSource', 'Other',
  ]);

  /** 响应 MIME 类型白名单前缀，用于二次过滤 */
  const ALLOWED_MIME_PATTERNS = [
    'application/json',
    'text/json',
    'text/plain',
    'text/html',
    'text/xml',
    'application/xml',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/graphql',
    'application/grpc',
    'application/x-ndjson',
    'text/event-stream',
  ];

  /**
   * 静态资源扩展名正则 — 当 CDP 未提供资源类型时作为兜底判断。
   * 命中此正则的 URL 会被判定为静态资源从而跳过录制。
   */
  const STATIC_EXT_RE = /\.(?:css|js|mjs|jsx|ts|tsx|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|map)(?:[?#]|$)/i;

  /**
   * 扩展页/插件自身资源等，不参与业务链路采集。
   */
  function shouldRecordNetworkUrl(url) {
    if (!url || typeof url !== 'string') return true;
    const scheme = url.trimStart().toLowerCase();
    if (scheme.startsWith('chrome-extension:')) return false;
    return true;
  }

  /**
   * 根据 CDP 资源类型、URL、HTTP 方法判断是否应该采集该请求。
   * @param {string} [method] 来自 CDP Network.Request 的 method（如忽略则不校验）
   */
  function shouldCaptureByType(resourceType, url, method) {
    if (!shouldRecordNetworkUrl(url)) return false;
    if (method && String(method).toUpperCase() === 'OPTIONS') return false;
    if (resourceType) {
      return ALLOWED_RESOURCE_TYPES.has(resourceType);
    }
    return !STATIC_EXT_RE.test(url);
  }

  /**
   * 判断 MIME 类型是否为 API / 数据响应（用于响应阶段二次过滤）。
   * 未知类型保留（返回 true），避免误丢。
   */
  function isApiMimeType(mime) {
    if (!mime) return true;
    const lower = mime.toLowerCase();
    return ALLOWED_MIME_PATTERNS.some((p) => lower.startsWith(p));
  }

  // =========================================================================
  // 2. Timing — 录制时间窗口参数
  // =========================================================================

  /** 网络静默多久后捕获操作后 A11y 快照（毫秒） */
  const NETWORK_IDLE_DELAY_MS = 1500;

  /** 滑动窗口时长：用户操作后多久内的请求关联到该操作（毫秒） */
  const ACTION_WINDOW_MS = 2000;

  /** 录制开始后忽略用户操作的宽限期（毫秒），避免误捕获启动点击 */
  const RECORDING_GRACE_MS = 800;

  /**
   * 由 scheme / record-launcher 触发录制时：在**已无进行中请求**的前提下，
   * 持续静默超过该时间则自动停止并导出（毫秒）。
   * 重型 SPA（如控制台类页面）常在首波请求后暂停数十秒再发起第二批接口，过短的窗口会过早导出。
   */
  const SCHEME_AUTO_IDLE_MS = 70_000;

  /**
   * scheme 录制至少持续该时长后，才允许因「空闲」自动停止（毫秒）。
   * 避免首屏接口完成后、业务接口尚未发出就触发 idle 导出。
   */
  const SCHEME_MIN_RECORDING_BEFORE_IDLE_MS = 55_000;

  /**
   * 由 scheme / record-launcher 触发的录制上限时长，超时自动停止并导出（毫秒）。
   */
  const SCHEME_MAX_RECORDING_MS = 120_000;

  // =========================================================================
  // 3. A11y — 无障碍树快照过滤
  // =========================================================================

  /** 生成 A11y 摘要时忽略的节点角色 */
  const A11Y_IGNORED_ROLES = new Set([
    'none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak',
    'ScrollArea', 'unknown',
  ]);

  // =========================================================================
  // 4. Action Capture — 用户操作采集
  // =========================================================================

  /** 仅捕获这些按键的 keydown 事件，减少噪音 */
  const SIGNIFICANT_KEYS = new Set([
    'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  ]);

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    // Request Capture
    ALLOWED_RESOURCE_TYPES,
    ALLOWED_MIME_PATTERNS,
    STATIC_EXT_RE,
    shouldRecordNetworkUrl,
    shouldCaptureByType,
    isApiMimeType,

    // Timing
    NETWORK_IDLE_DELAY_MS,
    ACTION_WINDOW_MS,
    RECORDING_GRACE_MS,
    SCHEME_AUTO_IDLE_MS,
    SCHEME_MIN_RECORDING_BEFORE_IDLE_MS,
    SCHEME_MAX_RECORDING_MS,

    // A11y
    A11Y_IGNORED_ROLES,

    // Action Capture
    SIGNIFICANT_KEYS,
  };
})();
