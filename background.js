'use strict';

importScripts('rules.js');

/**
 * Asia/Shanghai wall time (+08:00, fixed offset) with ms — no Intl fractionalSecondDigits
 * (avoids SW / engine quirks) and no cross-file init on `self`.
 * @param {number} epochMs
 * @returns {string}
 */
function formatTimestampCST(epochMs) {
  const sh = new Date(epochMs + 8 * 60 * 60 * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth() + 1)}-${pad(sh.getUTCDate())}` +
    `T${pad(sh.getUTCHours())}:${pad(sh.getUTCMinutes())}:${pad(sh.getUTCSeconds())}` +
    `.${pad(sh.getUTCMilliseconds(), 3)}+08:00`
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'idle' | 'recording' | 'packing'} */
let recorderState = 'idle';

/** @type {number | null} The tab being recorded */
let activeTabId = null;

/**
 * Reserved for future per-session export overrides (currently unused).
 * @type {null}
 */
let sessionExportOverride = null;

/**
 * Timeline of context blocks accumulated during the recording session.
 * @type {Array<ContextBlock>}
 */
const timeline = [];

/**
 * Map of CDP requestId -> pending network entry (built up from events).
 * @type {Map<string, NetworkEntry>}
 */
const pendingRequests = new Map();

/**
 * Completed network entries (response body fetched), keyed by requestId.
 * @type {Map<string, NetworkEntry>}
 */
const completedRequests = new Map();

/**
 * Map of CDP requestId -> pending WebSocket entry (accumulating frames).
 * @type {Map<string, NetworkEntry>}
 */
const pendingWebSockets = new Map();

// Counters for unique IDs
let contextCounter = 0;
let requestCounter = 0;

// Timers
/** @type {ReturnType<typeof setTimeout> | null} */
let networkIdleTimer = null;

// Timing constants — sourced from rules.js (WebTapeRules)
const {
  NETWORK_IDLE_DELAY_MS,
  RECORDING_GRACE_MS,
  SCHEME_AUTO_IDLE_MS,
  SCHEME_MIN_RECORDING_BEFORE_IDLE_MS,
  SCHEME_MAX_RECORDING_MS,
} = WebTapeRules;

/** scheme / launcher 触发的本次录制是否启用自动停止 */
let schemeAutoStopEnabled = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let schemeMaxStopTimer = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let schemeIdleStopTimer = null;

/** @type {number} Timestamp (Date.now()) when recording started; used for grace period */
let recordingStartTime = 0;

/**
 * CDP Network.* `timestamp` is monotonic seconds (tracing / navigation timeline), not Unix epoch.
 * First seen value + current Date establish a bridge to wall-clock ms; if monotonic jumps backward
 * (new document), re-anchor.
 */
let networkMonotonicOrigin = null;
/** @type {number|null} */
let networkWallOriginMs = null;

/** @type {string} Current page URL, tracked to detect SPA navigation changes */
let currentNavigationUrl = '';

/** @type {boolean} Set to true once the INITIAL block has been created */
let initialLoadComplete = false;

// Request capture functions — sourced from rules.js (WebTapeRules)
const { shouldCaptureByType, shouldRecordNetworkUrl, isApiMimeType } = WebTapeRules;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextContextId() {
  return `ctx_${String(++contextCounter).padStart(3, '0')}`;
}

function nextRequestId() {
  return `req_${String(++requestCounter).padStart(4, '0')}`;
}

function resetSession() {
  timeline.length = 0;
  pendingRequests.clear();
  completedRequests.clear();
  pendingWebSockets.clear();
  contextCounter = 0;
  requestCounter = 0;
  networkIdleTimer = null;
  networkMonotonicOrigin = null;
  networkWallOriginMs = null;
  currentNavigationUrl = '';
  initialLoadComplete = false;
}

/**
 * @param {number} monotonicSec
 * @returns {number}
 */
function wallMsFromNetworkMonotonic(monotonicSec) {
  if (typeof monotonicSec !== 'number' || !Number.isFinite(monotonicSec)) {
    return Date.now();
  }
  if (
    networkMonotonicOrigin != null
    && monotonicSec < networkMonotonicOrigin - 0.5
  ) {
    networkMonotonicOrigin = null;
    networkWallOriginMs = null;
  }
  if (networkMonotonicOrigin == null) {
    networkMonotonicOrigin = monotonicSec;
    networkWallOriginMs = Date.now();
  }
  return networkWallOriginMs + (monotonicSec - networkMonotonicOrigin) * 1000;
}

// ---------------------------------------------------------------------------
// CDP Helpers
// ---------------------------------------------------------------------------

/**
 * Send a CDP command to the given tab (defaults to the active recording tab).
 * @param {string} method
 * @param {Object} [params]
 * @param {number} [tabId]
 * @returns {Promise<any>}
 */
function cdpSend(method, params = {}, tabId = activeTabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// A11y Tree Capture
// ---------------------------------------------------------------------------

/**
 * Fetch the full accessibility tree and produce a compact text summary.
 * @returns {Promise<string>}
 */
async function captureA11ySummary() {
  try {
    const result = await cdpSend('Accessibility.getFullAXTree', {});
    if (!result || !result.nodes) return '';
    return summariseA11yNodes(result.nodes);
  } catch (e) {
    console.warn('[WebTape] A11y capture failed:', e.message);
    return '';
  }
}

/**
 * Convert raw AX nodes to a concise multi-line text summary.
 * Only includes nodes that carry meaningful semantic content.
 * @param {Array<Object>} nodes
 * @returns {string}
 */
function summariseA11yNodes(nodes) {
  const lines = [];

  for (const node of nodes) {
    const role = node.role && node.role.value;
    if (!role || WebTapeRules.A11Y_IGNORED_ROLES.has(role)) continue;

    const name = node.name && node.name.value ? node.name.value.trim() : '';
    const description = node.description && node.description.value
      ? node.description.value.trim() : '';

    if (!name && !description) continue;

    const label = name || description;
    lines.push(`[${role} '${label.slice(0, 100)}']`);
  }

  return lines.join(' \n ');
}

/**
 * Capture an A11y snapshot for any tab, attaching the debugger temporarily
 * if the recorder is not currently active on that tab.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function captureSnapshotForTab(tabId) {
  // Reuse the existing CDP session when recording on this tab
  if (recorderState === 'recording' && activeTabId === tabId) {
    return captureA11ySummary();
  }

  // Temporarily attach the debugger
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });

  try {
    await cdpSend('Accessibility.enable', {}, tabId);
    const result = await cdpSend('Accessibility.getFullAXTree', {}, tabId);
    return result && result.nodes ? summariseA11yNodes(result.nodes) : '';
  } finally {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// Network Event Handlers
// ---------------------------------------------------------------------------

/**
 * @param {NetworkEntry} entry
 * @returns {number}
 */
function entryStartWallMs(entry) {
  if (entry.startWallMs != null) return entry.startWallMs;
  return Math.round(entry.startTime * 1000);
}

function handleRequestWillBeSent(params) {
  if (!shouldCaptureByType(params.type, params.request.url, params.request.method)) return;

  const reqId = nextRequestId();
  const startWallMs = Math.round(wallMsFromNetworkMonotonic(params.timestamp));
  /** @type {NetworkEntry} */
  const entry = {
    reqId,
    cdpRequestId: params.requestId,
    entryType: 'http',
    method: params.request.method,
    url: params.request.url,
    requestHeaders: params.request.headers,
    requestBody: params.request.postData || null,
    status: null,
    responseHeaders: null,
    responseBody: null,
    startTime: params.timestamp,
    startWallMs: startWallMs,
    endTime: null,
    endWallMs: null,
  };
  pendingRequests.set(params.requestId, entry);
  refreshSchemeIdleDeadline();
  console.log('[WebTape] Captured request:', params.request.method, params.request.url,
    '(type:', params.type || 'unknown', ')');
}

function handleResponseReceived(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;

  const mime = params.response.mimeType;
  if (!isApiMimeType(mime)) {
    console.log('[WebTape] Dropping non-API response (mime:', mime, '):', entry.url);
    pendingRequests.delete(params.requestId);
    return;
  }

  entry.status = params.response.status;
  entry.responseHeaders = params.response.headers;
  entry.mimeType = mime;

  // Mark SSE streams so we accumulate events instead of fetching the body
  if (mime && mime.toLowerCase().startsWith('text/event-stream')) {
    entry.entryType = 'sse';
    entry.sseEvents = [];
    console.log('[WebTape] SSE stream detected:', entry.url);
  }
}

/**
 * Handle an individual SSE event received on an EventSource stream.
 * CDP fires this for each SSE message while the connection is open.
 */
function handleEventSourceMessageReceived(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;

  // Ensure the entry is marked as SSE (in case responseReceived hasn't fired yet)
  if (entry.entryType !== 'sse') {
    entry.entryType = 'sse';
    entry.sseEvents = entry.sseEvents || [];
  }

  entry.sseEvents.push({
    timestamp: params.timestamp,
    event: params.eventName || 'message',
    id: params.eventId || '',
    data: params.data || '',
  });
  refreshSchemeIdleDeadline();
}

async function handleLoadingFinished(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;
  entry.endTime = params.timestamp;
  entry.endWallMs = Math.round(wallMsFromNetworkMonotonic(params.timestamp));

  // For SSE entries, the body is the accumulated events — skip CDP body fetch
  if (entry.entryType === 'sse') {
    pendingRequests.delete(params.requestId);
    completedRequests.set(params.requestId, entry);
    scheduleNetworkIdleCheck();
    refreshSchemeIdleDeadline();
    console.log('[WebTape] SSE stream completed:', entry.url,
      '— events:', entry.sseEvents ? entry.sseEvents.length : 0);
    return;
  }

  // Fetch response body for regular HTTP requests
  try {
    const bodyResult = await cdpSend('Network.getResponseBody', { requestId: params.requestId });
    if (bodyResult) {
      entry.responseBody = bodyResult.base64Encoded
        ? `(base64) ${bodyResult.body}`
        : bodyResult.body;
    }
  } catch (_e) {
    // Body not available for all request types (e.g. preflight, redirects)
  }

  pendingRequests.delete(params.requestId);
  completedRequests.set(params.requestId, entry);

  // Reset the network-idle timer
  scheduleNetworkIdleCheck();
  refreshSchemeIdleDeadline();
}

// ---------------------------------------------------------------------------
// WebSocket Event Handlers
// ---------------------------------------------------------------------------

/**
 * A new WebSocket connection has been created.
 * CDP fires this before the HTTP upgrade handshake.
 */
function handleWebSocketCreated(params) {
  if (!shouldRecordNetworkUrl(params.url)) return;

  const reqId = nextRequestId();
  const wsStartMs = Date.now();
  /** @type {NetworkEntry} */
  const entry = {
    reqId,
    cdpRequestId: params.requestId,
    entryType: 'websocket',
    method: 'GET',  // WebSocket upgrade is always GET
    url: params.url,
    requestHeaders: null,
    requestBody: null,
    status: null,
    responseHeaders: null,
    responseBody: null,
    // webSocketCreated has no monotonic timestamp; use wall clock (sort/export use startWallMs)
    startTime: wsStartMs / 1000,
    startWallMs: wsStartMs,
    endTime: null,
    endWallMs: null,
    wsMessages: [],
  };
  pendingWebSockets.set(params.requestId, entry);
  refreshSchemeIdleDeadline();
  console.log('[WebTape] WebSocket created:', params.url);
}

/**
 * The WebSocket handshake response has been received from the server.
 */
function handleWebSocketHandshakeResponseReceived(params) {
  const entry = pendingWebSockets.get(params.requestId);
  if (!entry) return;

  const resp = params.response || {};
  entry.status = resp.status || 101;
  entry.responseHeaders = resp.headers || null;
  entry.requestHeaders = resp.requestHeaders || entry.requestHeaders;
}

/**
 * A WebSocket frame has been sent by the client.
 */
function handleWebSocketFrameSent(params) {
  const entry = pendingWebSockets.get(params.requestId);
  if (!entry) return;

  const frame = params.response || {};
  entry.wsMessages.push({
    timestamp: params.timestamp,
    direction: 'sent',
    opcode: frame.opcode || 1,
    data: frame.payloadData || '',
  });
  refreshSchemeIdleDeadline();
}

/**
 * A WebSocket frame has been received from the server.
 */
function handleWebSocketFrameReceived(params) {
  const entry = pendingWebSockets.get(params.requestId);
  if (!entry) return;

  const frame = params.response || {};
  entry.wsMessages.push({
    timestamp: params.timestamp,
    direction: 'received',
    opcode: frame.opcode || 1,
    data: frame.payloadData || '',
  });
  refreshSchemeIdleDeadline();
}

/**
 * The WebSocket connection has been closed.
 */
function handleWebSocketClosed(params) {
  const entry = pendingWebSockets.get(params.requestId);
  if (!entry) return;

  entry.endTime = params.timestamp;
  entry.endWallMs = Math.round(wallMsFromNetworkMonotonic(params.timestamp));
  pendingWebSockets.delete(params.requestId);
  completedRequests.set(params.requestId, entry);

  // Reset the network-idle timer
  scheduleNetworkIdleCheck();
  refreshSchemeIdleDeadline();

  console.log('[WebTape] WebSocket closed:', entry.url,
    '— messages:', entry.wsMessages.length);
}

// ---------------------------------------------------------------------------
// Timeline & network summaries
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NetworkEntry
 * @property {string} reqId
 * @property {string} cdpRequestId
 * @property {'http'|'sse'|'websocket'} entryType
 * @property {string} method
 * @property {string} url
 * @property {Object} requestHeaders
 * @property {string|null} requestBody
 * @property {number|null} status
 * @property {Object|null} responseHeaders
 * @property {string|null} responseBody
 * @property {string|null} mimeType
 * @property {number} startTime
 * @property {number} [startWallMs]
 * @property {number|null} endTime
 * @property {number|null} [endWallMs]
 * @property {Array<{timestamp:number, event:string, id:string, data:string}>} [sseEvents]
 * @property {Array<{timestamp:number, direction:'sent'|'received', opcode:number, data:string}>} [wsMessages]
 */

/**
 * @typedef {Object} ContextBlock
 * @property {string} context_id
 * @property {number} timestamp
 * @property {string} [timestamp_cst]
 * @property {Object} [state]
 * @property {Object} [action]
 * @property {Array}  [triggered_network]
 * @property {string} [post_action_a11y_tree_summary]
 */

/**
 * Assign every completed request to exactly one timeline block using wall time:
 * latest block with block.timestamp <= request_start_ms (requests before the
 * first block go to INITIAL). Export-time only — no orphan requests.
 * @param {ContextBlock[]} timelineBlocks
 * @param {NetworkEntry[]} allRequestEntries
 */
function assignCompletedRequestsToTimeline(timelineBlocks, allRequestEntries) {
  if (!timelineBlocks.length) return;

  for (const b of timelineBlocks) {
    b.triggered_network = [];
  }

  const sorted = [...allRequestEntries].sort(
    (a, b) => entryStartWallMs(a) - entryStartWallMs(b),
  );
  const firstTs = timelineBlocks[0].timestamp;

  for (const entry of sorted) {
    const reqMs = entryStartWallMs(entry);
    let idx = 0;
    if (reqMs >= firstTs) {
      for (let i = timelineBlocks.length - 1; i >= 0; i--) {
        if (timelineBlocks[i].timestamp <= reqMs) {
          idx = i;
          break;
        }
      }
    }
    timelineBlocks[idx].triggered_network.push(toNetworkSummary(entry));
  }
}

/**
 * Receive a user action from the content script and push a context block.
 */
function handleUserAction(payload) {
  if (recorderState !== 'recording') return;
  refreshSchemeIdleDeadline();
  if (Date.now() - recordingStartTime < RECORDING_GRACE_MS) return;

  const ts = Date.now();
  /** @type {ContextBlock} */
  const block = {
    context_id: nextContextId(),
    timestamp: ts,
    timestamp_cst: formatTimestampCST(ts),
    action: {
      type: payload.actionType,
      target_element: payload.targetDescriptor,
      tag: payload.tagName,
      id: payload.id,
      aria_label: payload.ariaLabel,
    },
    triggered_network: null,
    post_action_a11y_tree_summary: null,
  };
  timeline.push(block);
}

/**
 * Handle a Page.frameNavigated CDP event to detect SPA URL changes.
 */
function handleFrameNavigated(params) {
  if (!initialLoadComplete) return;
  if (recorderState !== 'recording') return;

  const { frame } = params;
  if (frame.parentId) return;

  const newUrl = frame.url;
  if (!newUrl || newUrl === currentNavigationUrl) return;

  currentNavigationUrl = newUrl;
  console.log('[WebTape] URL_CHANGE detected:', newUrl);

  const ts = Date.now();
  /** @type {ContextBlock} */
  const block = {
    context_id: nextContextId(),
    timestamp: ts,
    timestamp_cst: formatTimestampCST(ts),
    state: {
      type: 'URL_CHANGE',
      url: newUrl,
      title: '',
    },
    triggered_network: null,
  };
  timeline.push(block);
  refreshSchemeIdleDeadline();

  chrome.tabs.get(activeTabId).then((tab) => {
    if (tab && tab.title) block.state.title = tab.title;
  }).catch(() => {});
}

function responseBasenameFromReqId(reqId) {
  return `${reqId.replace(/^req_/, 'res_')}.json`;
}

function toNetworkSummary(entry) {
  const summary = {
    req_id: entry.reqId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    type: entry.entryType || 'http',
    detail_path: {
      request: `requests/${entry.reqId}.json`,
      response: `responses/${responseBasenameFromReqId(entry.reqId)}`,
    },
  };

  const st = entry.status ?? 0;
  if (st >= 200 && st < 300) {
    const body = entry.entryType === 'sse'
      ? entry.sseEvents
      : entry.entryType === 'websocket'
        ? entry.wsMessages
        : entry.responseBody;

    if (body != null) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      summary.response_body_bytes = new TextEncoder().encode(raw).byteLength;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Network Idle Detection
// ---------------------------------------------------------------------------

function scheduleNetworkIdleCheck() {
  if (networkIdleTimer !== null) clearTimeout(networkIdleTimer);
  networkIdleTimer = setTimeout(onNetworkIdle, NETWORK_IDLE_DELAY_MS);
}

async function onNetworkIdle() {
  networkIdleTimer = null;
  if (recorderState !== 'recording') return;

  // Capture A11y snapshot for the most recently finalised action context
  const a11ySummary = await captureA11ySummary();

  // Attach to the last timeline block that is missing a post-action snapshot
  for (let i = timeline.length - 1; i >= 0; i--) {
    const block = timeline[i];
    if (block.action && block.post_action_a11y_tree_summary === null) {
      block.post_action_a11y_tree_summary = a11ySummary;
      block.post_action_a11y_tree_summary_length = a11ySummary ? a11ySummary.length : 0;
      break;
    }
  }
}

function clearSchemeAutoStopTimersOnly() {
  if (schemeMaxStopTimer !== null) {
    clearTimeout(schemeMaxStopTimer);
    schemeMaxStopTimer = null;
  }
  if (schemeIdleStopTimer !== null) {
    clearTimeout(schemeIdleStopTimer);
    schemeIdleStopTimer = null;
  }
}

/**
 * Scheme 自动停止：仅在无进行中网络条目时启动 idle 倒计时；录制未满最短时延后。
 * 避免「首波请求完成 → 长间隙 → 误导出」导致漏采后续加载链路。
 */
function refreshSchemeIdleDeadline() {
  if (!schemeAutoStopEnabled || recorderState !== 'recording') return;
  if (schemeIdleStopTimer !== null) {
    clearTimeout(schemeIdleStopTimer);
    schemeIdleStopTimer = null;
  }
  const busy = pendingRequests.size > 0 || pendingWebSockets.size > 0;
  if (busy) return;

  const elapsed = Date.now() - recordingStartTime;
  const scheduleIdleFire = () => {
    schemeIdleStopTimer = setTimeout(() => {
      schemeIdleStopTimer = null;
      autoStopSchemeRecording('idle');
    }, SCHEME_AUTO_IDLE_MS);
  };

  if (elapsed < SCHEME_MIN_RECORDING_BEFORE_IDLE_MS) {
    schemeIdleStopTimer = setTimeout(() => {
      schemeIdleStopTimer = null;
      refreshSchemeIdleDeadline();
    }, SCHEME_MIN_RECORDING_BEFORE_IDLE_MS - elapsed);
    return;
  }
  scheduleIdleFire();
}

function armSchemeAutoStopTimers() {
  clearSchemeAutoStopTimersOnly();
  schemeAutoStopEnabled = true;
  schemeMaxStopTimer = setTimeout(() => {
    schemeMaxStopTimer = null;
    autoStopSchemeRecording('max');
  }, SCHEME_MAX_RECORDING_MS);
  refreshSchemeIdleDeadline();
}

async function autoStopSchemeRecording(reason) {
  if (!schemeAutoStopEnabled || recorderState !== 'recording') return;
  clearSchemeAutoStopTimersOnly();
  schemeAutoStopEnabled = false;
  console.log('[WebTape] Scheme auto-stop:', reason);
  try {
    await stopAndExport();
  } catch (e) {
    console.error('[WebTape] Scheme auto-stop export failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Recording Lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {number} tabId
 * @param {boolean} refreshFirst
 * @param {{ sessionExport?: unknown, schemeAutoStop?: boolean }} [opts]
 */
async function startRecording(tabId, refreshFirst, opts) {
  console.log('[WebTape] startRecording called — tabId:', tabId, ', refreshFirst:', refreshFirst);

  if (recorderState !== 'idle') {
    console.error('[WebTape] startRecording: already in state', recorderState);
    throw new Error('Recording already in progress.');
  }

  resetSession();
  clearSchemeAutoStopTimersOnly();
  schemeAutoStopEnabled = false;
  sessionExportOverride = null;
  activeTabId = tabId;
  recorderState = 'recording';

  // Attach debugger
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });

  // Enable Network domain
  await cdpSend('Network.enable', {});

  // Enable Accessibility domain
  await cdpSend('Accessibility.enable', {});

  // Always enable Page domain — needed for loadEventFired and frameNavigated (SPA nav)
  await cdpSend('Page.enable', {});

  if (refreshFirst) {
    // Wait for page load event before taking initial A11y snapshot
    await new Promise((resolve) => {
      const handler = (source, method) => {
        if (source.tabId === tabId && method === 'Page.loadEventFired') {
          chrome.debugger.onEvent.removeListener(handler);
          resolve();
        }
      };
      chrome.debugger.onEvent.addListener(handler);
      chrome.tabs.reload(tabId);
    });
  }

  // Gather basic page info and initial A11y snapshot
  console.log('[WebTape] Capturing initial page info and A11y snapshot…');
  const tab = await chrome.tabs.get(tabId);
  const initialA11y = await captureA11ySummary();
  const ts = Date.now();
  /** @type {ContextBlock} */
  const initialBlock = {
    context_id: nextContextId(),
    timestamp: ts,
    timestamp_cst: formatTimestampCST(ts),
    state: {
      type: 'INITIAL',
      url: tab.url || '',
      title: tab.title || '',
      fav_icon_url: tab.favIconUrl || '',
      a11y_tree_summary: initialA11y,
    },
    triggered_network: null,
  };
  timeline.push(initialBlock);
  recordingStartTime = Date.now();

  // Track current URL for SPA navigation detection
  currentNavigationUrl = tab.url || '';
  initialLoadComplete = true;

  console.log('[WebTape] Recording started successfully.');
  if (opts && opts.schemeAutoStop) {
    armSchemeAutoStopTimers();
  }
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
function waitForTabLoadComplete(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        if (!settled) {
          settled = true;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          reject(new Error(chrome.runtime.lastError.message));
        }
        return;
      }
      if (tab.status === 'complete') finish();
    });
  });
}

/**
 * Open a tab at URL (http/https) and start recording after load completes.
 * @param {string} targetUrlRaw
 */
async function startRecordingFromSchemeUrl(targetUrlRaw) {
  let u = (targetUrlRaw || '').trim();
  if (!u) throw new Error('Empty URL.');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.');
  }
  const tab = await chrome.tabs.create({ url: u, active: true });
  await waitForTabLoadComplete(tab.id);
  // 与 Popup「Refresh & Record」一致：附加 debugger 后整页刷新，完整采集本轮文档与后续 API 加载。
  await startRecording(tab.id, true, { schemeAutoStop: true });
}

const NATIVE_HOST_NAME = 'com.webtape.receiver';

/**
 * Send the recording payload to the native host via Native Messaging.
 * Returns a promise that resolves with the host's response message.
 */
function sendToNativeHost(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (err) {
      reject(new Error(
        'Native Messaging 连接失败：' + (err.message || err) +
        '。请确认已运行 webtape install 完成初始化。'
      ));
      return;
    }

    const timeout = setTimeout(() => {
      port.disconnect();
      reject(new Error('Native Messaging 超时（10s）。请检查 webtape 是否正常安装。'));
    }, 10000);

    port.onMessage.addListener((msg) => {
      clearTimeout(timeout);
      port.disconnect();
      if (msg && msg.type === 'error') {
        reject(new Error('webtape 处理出错：' + msg.error));
      } else {
        resolve(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(
          'Native Messaging 断开：' + chrome.runtime.lastError.message +
          '。请确认已运行 webtape install 完成初始化。'
        ));
      }
    });

    port.postMessage({ type: 'recording', payload });
  });
}

async function stopAndExport() {
  console.log('[WebTape] stopAndExport called, current state:', recorderState);

  if (recorderState !== 'recording') {
    console.error('[WebTape] stopAndExport: not in recording state, aborting.');
    throw new Error('Not recording.');
  }

  recorderState = 'packing';
  const recordingEndedAt = Date.now();

  try {
  // 仍在进行中的 HTTP：在 detach 前尽量拉取响应体并纳入导出，避免 idle/max 停表时漏请求
  if (activeTabId !== null) {
    for (const [cdpId, entry] of [...pendingRequests.entries()]) {
      if (entry.entryType !== 'http') continue;
      try {
        const bodyResult = await cdpSend('Network.getResponseBody', { requestId: cdpId });
        if (bodyResult) {
          entry.responseBody = bodyResult.base64Encoded
            ? `(base64) ${bodyResult.body}`
            : bodyResult.body;
        }
      } catch (_e) {
        /* body 可能尚未就绪或不可读 */
      }
      if (entry.endTime == null) entry.endTime = Date.now() / 1000;
      if (entry.endWallMs == null) entry.endWallMs = Date.now();
      if (entry.startWallMs == null) {
        entry.startWallMs = Math.round(wallMsFromNetworkMonotonic(entry.startTime));
      }
      pendingRequests.delete(cdpId);
      completedRequests.set(cdpId, entry);
      console.log('[WebTape] Finalised in-flight HTTP:', entry.method, entry.url);
    }
  }

  // Detach debugger
  if (activeTabId !== null) {
    console.log('[WebTape] Detaching debugger from tab', activeTabId);
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId: activeTabId }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[WebTape] Debugger detach warning:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    });
  }

  // Build export data
  console.log('[WebTape] Building export data — timeline blocks:', timeline.length,
    ', completed requests:', completedRequests.size);

  // Finalise any still-open SSE streams and WebSocket connections
  const finalizeOpenEntries = (sourceMap, filterFn) => {
    for (const [cdpId, entry] of sourceMap) {
      if (filterFn && !filterFn(entry)) continue;
      entry.endTime = Date.now() / 1000;
      entry.endWallMs = Date.now();
      if (entry.startWallMs == null) {
        entry.startWallMs = Math.round(wallMsFromNetworkMonotonic(entry.startTime));
      }
      sourceMap.delete(cdpId);
      completedRequests.set(cdpId, entry);
      console.log(`[WebTape] Finalised open ${entry.entryType}:`, entry.url);
    }
  };

  finalizeOpenEntries(pendingRequests, (e) => e.entryType === 'sse');
  finalizeOpenEntries(pendingWebSockets);

  const allRequests = [...completedRequests.values()];

  assignCompletedRequestsToTimeline(timeline, allRequests);

  // Build snapshots map: context_id → a11y tree text (for action blocks only)
  const snapshotsData = {};
  for (const block of timeline) {
    if (block.action && block.post_action_a11y_tree_summary) {
      snapshotsData[block.context_id] = block.post_action_a11y_tree_summary;
    }
  }

  const recordingStartedAt =
    recordingStartTime > 0 ? recordingStartTime : (timeline[0] ? timeline[0].timestamp : recordingEndedAt);

  // Level 1: index.json (skeleton only) — timeline entries
  const indexData = timeline.map((block) => {
    const entry = {
      context_id: block.context_id,
      timestamp: block.timestamp,
      timestamp_cst: block.timestamp_cst || formatTimestampCST(block.timestamp),
    };
    if (block.state) {
      entry.state = block.state;
    }
    if (block.action) {
      entry.action = block.action;
    }
    if (block.triggered_network) {
      entry.triggered_network = block.triggered_network;
    }
    // Reference snapshot by id instead of inlining the full a11y text
    if (block.action && block.post_action_a11y_tree_summary) {
      entry.snapshot_id = block.context_id;
    }
    return entry;
  });

  // Level 2: requests/ and responses/
  const requestsData = {};
  const responsesData = {};

  function tryParseJson(str) {
    if (typeof str !== 'string') return str;
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch (_e) { /* not valid JSON */ }
    return str;
  }

  for (const entry of allRequests) {
    const reqWallMs = entryStartWallMs(entry);
    const reqPayload = {
      req_id: entry.reqId,
      timestamp_cst: formatTimestampCST(reqWallMs),
      type: entry.entryType || 'http',
      method: entry.method,
      url: entry.url,
      headers: entry.requestHeaders,
      body: tryParseJson(entry.requestBody),
    };
    requestsData[`${entry.reqId}.json`] = reqPayload;

    const resWallMs = entry.endWallMs != null
      ? entry.endWallMs
      : entry.endTime != null
        ? Math.round(wallMsFromNetworkMonotonic(entry.endTime))
        : reqWallMs;

    // Build response payload based on entry type
    const resPayload = {
      req_id: entry.reqId,
      timestamp_cst: formatTimestampCST(resWallMs),
      type: entry.entryType || 'http',
      status: entry.status,
      headers: entry.responseHeaders,
      mime_type: entry.mimeType,
    };

    if (entry.entryType === 'sse') {
      resPayload.body = entry.sseEvents || [];
    } else if (entry.entryType === 'websocket') {
      resPayload.body = entry.wsMessages || [];
    } else {
      resPayload.body = tryParseJson(entry.responseBody);
    }

    responsesData[responseBasenameFromReqId(entry.reqId)] = resPayload;
  }

  // Build the payload to send via Native Messaging
  let siteHostname = '';
  try {
    const siteUrl = indexData && indexData.length > 0 && indexData[0].state && indexData[0].state.url;
    if (siteUrl) {
      siteHostname = new URL(siteUrl).hostname;
    }
  } catch (_e) { /* ignore */ }

  const now = Date.now();
  const manifestVersion = chrome.runtime.getManifest().version;
  const nativePayload = {
    meta: {
      timestamp: formatTimestampCST(now),
      epoch: now,
      version: manifestVersion,
      source: 'WebTape',
      hostname: siteHostname || undefined,
      recording_started_at_cst: formatTimestampCST(recordingStartedAt),
      recording_started_at_epoch_ms: recordingStartedAt,
      recording_ended_at_cst: formatTimestampCST(recordingEndedAt),
      recording_ended_at_epoch_ms: recordingEndedAt,
    },
    content: {
      'index.json': indexData,
      snapshots: snapshotsData,
      requests: requestsData,
      responses: responsesData,
    },
  };

  console.log('[WebTape] Sending payload via Native Messaging…');
  await sendToNativeHost(nativePayload);
  console.log('[WebTape] Native host acknowledged payload.');

  resetSession();
  activeTabId = null;
  recorderState = 'idle';
  console.log('[WebTape] Export complete, session reset.');
  return { exportMode: 'native' };
  } catch (err) {
    resetSession();
    activeTabId = null;
    recorderState = 'idle';
    throw err;
  } finally {
    sessionExportOverride = null;
    clearSchemeAutoStopTimersOnly();
    schemeAutoStopEnabled = false;
  }
}

// ---------------------------------------------------------------------------
// CDP Event Router
// ---------------------------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== activeTabId) return;

  switch (method) {
    case 'Network.requestWillBeSent':
      handleRequestWillBeSent(params);
      break;
    case 'Network.responseReceived':
      handleResponseReceived(params);
      break;
    case 'Network.loadingFinished':
      handleLoadingFinished(params);
      break;

    // SSE events
    case 'Network.eventSourceMessageReceived':
      handleEventSourceMessageReceived(params);
      break;

    // WebSocket events
    case 'Network.webSocketCreated':
      handleWebSocketCreated(params);
      break;
    case 'Network.webSocketHandshakeResponseReceived':
      handleWebSocketHandshakeResponseReceived(params);
      break;
    case 'Network.webSocketFrameSent':
      handleWebSocketFrameSent(params);
      break;
    case 'Network.webSocketFrameReceived':
      handleWebSocketFrameReceived(params);
      break;
    case 'Network.webSocketClosed':
      handleWebSocketClosed(params);
      break;

    // Page navigation events (SPA route changes)
    case 'Page.frameNavigated':
      handleFrameNavigated(params);
      break;

    default:
      break;
  }
});

// Detach cleanup if the user closes the tab or navigates away
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === activeTabId && recorderState === 'recording') {
    console.warn('[WebTape] Debugger detached unexpectedly; ending session.');
    recorderState = 'idle';
    activeTabId = null;
    clearSchemeAutoStopTimersOnly();
    schemeAutoStopEnabled = false;
  }
});

// ---------------------------------------------------------------------------
// Message Handler (Popup -> Background)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message;
  console.log('[WebTape] Message received:', type);

  if (type === 'GET_STATE') {
    sendResponse({
      state: recorderState,
      stats: {
        actions: timeline.filter((b) => b.action).length,
        requests: completedRequests.size + pendingWebSockets.size,
        contexts: timeline.length,
      },
    });
    return false;
  }

  if (type === 'GET_STATS') {
    sendResponse({
      actions: timeline.filter((b) => b.action).length,
      requests: completedRequests.size + pendingWebSockets.size,
      contexts: timeline.length,
    });
    return false;
  }

  if (type === 'USER_ACTION') {
    handleUserAction(message.payload);
    return false;
  }

  if (type === 'START_DIRECT') {
    startRecording(message.tabId, false)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  if (type === 'START_REFRESH') {
    startRecording(message.tabId, true)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  if (type === 'SCHEME_START_RECORDING') {
    startRecordingFromSchemeUrl(message.url)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (type === 'STOP_EXPORT') {
    stopAndExport()
      .then((result) => sendResponse({ ok: true, exportMode: result.exportMode }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  if (type === 'CAPTURE_SNAPSHOT') {
    captureSnapshotForTab(message.tabId)
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  return false;
});
