/**
 * webtape 接收/呈现层规则 — 集中管理
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ 边界说明                                                           │
 * │                                                                     │
 * │ 插件层（根目录 rules.js）       → 控制「采集什么」                 │
 * │   哪些网络请求要录制、哪些用户操作要捕获、时间窗口参数、           │
 * │   A11y 树过滤等。                                                   │
 * │                                                                     │
 * │ 接收层（本文件）                → 控制「如何呈现」                 │
 * │   导出 JSON / _context.md 综述时的头噪音过滤、body 截断阈值、     │
 * │   协议过滤（只在 context 中展示 HTTPS/WSS）、时间线加工规则        │
 * │  （如移除首个误捕获 CLICK）、cookie 脱敏等。                       │
 * └─────────────────────────────────────────────────────────────────────┘
 */

// =========================================================================
// 1. Header Noise Filtering — context 综述中过滤掉的无关请求/响应头
// =========================================================================

/** 精确匹配的噪音 header 名（全部小写）— 请求+响应均适用 */
export const NOISE_HEADERS = new Set([
  'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'content-length', 'content-type', 'dnt', 'etag', 'if-modified-since',
  'if-none-match', 'keep-alive', 'pragma', 'server', 'vary', 'date', 'age',
  'expires', 'last-modified', 'transfer-encoding', 'x-powered-by',
  'x-request-id', 'x-frame-options', 'x-content-type-options',
  'x-xss-protection',
]);

/** 仅请求：浏览器几乎总会带的头，context 中不展示 */
export const NOISE_HEADERS_REQUEST_ONLY = new Set([
  'accept', 'origin', 'referer', 'user-agent', 'x-requested-with',
]);

/** 仅响应：CDN/网关追踪、耗时类，对业务链综述价值低 */
export const NOISE_HEADERS_RESPONSE_ONLY = new Set([
  'server-timing', 'x-req-id', 'x-server-cost',
]);

/** 前缀匹配的噪音 header 名（全部小写） */
export const NOISE_HEADER_PREFIXES = [
  'sec-', 'content-security-policy', 'strict-transport-security',
  'access-control-', 'permissions-policy', 'cross-origin-',
  'report-to', 'nel', ':',
];

/**
 * 判断一个 header 是否为噪音（应在 context 综述中过滤掉）。
 * @param role 传入 `request` / `response` 时可应用按侧过滤（如 UA、content-type、eo-*）。
 */
export function isNoiseHeader(
  name: string,
  role?: 'request' | 'response',
): boolean {
  const lower = name.toLowerCase();
  if (NOISE_HEADERS.has(lower)) return true;
  if (NOISE_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (role === 'request' && NOISE_HEADERS_REQUEST_ONLY.has(lower)) return true;
  if (role === 'response') {
    if (NOISE_HEADERS_RESPONSE_ONLY.has(lower)) return true;
    if (lower.startsWith('eo-')) return true;
  }
  return false;
}

// =========================================================================
// 2. Cookie / Sensitive Header Rendering — 脱敏规则
// =========================================================================

/**
 * 需要脱敏渲染的 header 名 → 处理策略。
 * - 'cookie'     → 只显示 cookie 名称列表，不显示值
 * - 'set-cookie' → 只提示存在
 */
export const SENSITIVE_HEADER_RULES: Record<string, 'cookie_names' | 'presence_only'> = {
  cookie: 'cookie_names',
  'set-cookie': 'presence_only',
};

/** header 值的最大显示长度，超出截断 */
export const HEADER_VALUE_MAX_LENGTH = 300;

// =========================================================================
// 3. Body Rendering — context 中的 body 长度阈值与超大提示档位（按字节）
// =========================================================================

/** body 全文展示阈值（JS 字符串 .length），不超过则完整写入 context */
export const BODY_FULL_LIMIT = 1000;

/** 超过 BODY_FULL_LIMIT 时，依据 UTF-8 字节数选择提示语气 */
export const BODY_OVERSIZE_HINT_LT_LARGE = 20 * 1024;
export const BODY_OVERSIZE_HINT_LT_HUGE = 500 * 1024;

// =========================================================================
// 4. Protocol Filtering — context 综述中只展示安全协议的请求
// =========================================================================

/**
 * 不允许出现在 context 综述中的协议。
 * 即：纯 http / ws 的请求会被过滤掉（只保留 https / wss 等）。
 */
export const DISALLOWED_PROTOCOLS = new Set(['http:', 'ws:']);

/**
 * 判断 URL 对应的协议是否允许出现在 context 综述中。
 * 返回 true 表示允许（即非 http/ws）。
 */
export function isAllowedProtocol(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase();
    return !DISALLOWED_PROTOCOLS.has(protocol);
  } catch {
    return false;
  }
}

// =========================================================================
// 5. Timeline Processing — 时间线加工规则
// =========================================================================

/**
 * 是否移除时间线中第一个 CLICK 操作。
 * 录制启动时用户点击"开始录制"按钮通常会被 content script 捕获为第一个 CLICK，
 * 属于误捕获，应在呈现时剔除。
 */
export const STRIP_FIRST_CLICK = true;
