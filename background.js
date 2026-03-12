'use strict';

importScripts('lib/jszip.min.js');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {'idle' | 'recording' | 'packing'} */
let recorderState = 'idle';

/** @type {number | null} The tab being recorded */
let activeTabId = null;

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

/**
 * Queue of pending user actions waiting for their sliding-window to close.
 * @type {Array<PendingAction>}
 */
const pendingActions = [];

// Counters for unique IDs
let contextCounter = 0;
let requestCounter = 0;

// Timers
/** @type {ReturnType<typeof setTimeout> | null} */
let networkIdleTimer = null;

// Constants
const NETWORK_IDLE_DELAY_MS = 1500; // ms of network silence before capturing post-action A11y
const ACTION_WINDOW_MS = 2000;      // ms sliding window to associate requests with an action

// Resource types from CDP that represent API / data requests we want to capture.
const ALLOWED_RESOURCE_TYPES = new Set([
  'XHR', 'Fetch', 'WebSocket', 'EventSource', 'Other',
]);

// MIME type prefixes / substrings that indicate API / data responses.
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

// URL path extensions that are definitely static resources — used as a fallback
// when CDP does not provide a resource type.
const STATIC_EXT_RE = /\.(?:css|js|mjs|jsx|ts|tsx|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|ogg|mp3|wav|map)(?:[?#]|$)/i;

/**
 * Determine whether a request should be captured based on its CDP resource
 * type and URL.  Returns `true` for API / data requests only.
 */
function shouldCaptureByType(resourceType, url) {
  if (resourceType) {
    return ALLOWED_RESOURCE_TYPES.has(resourceType);
  }
  return !STATIC_EXT_RE.test(url);
}

/**
 * Check whether a MIME type looks like an API / data response.
 */
function isApiMimeType(mime) {
  if (!mime) return true; // unknown → keep to be safe
  const lower = mime.toLowerCase();
  return ALLOWED_MIME_PATTERNS.some((p) => lower.startsWith(p));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextContextId() {
  return `ctx_${String(++contextCounter).padStart(3, '0')}`;
}

function nextRequestId() {
  return `req_${String(++requestCounter).padStart(4, '0')}_${Date.now()}`;
}

function resetSession() {
  timeline.length = 0;
  pendingRequests.clear();
  completedRequests.clear();
  pendingWebSockets.clear();
  pendingActions.length = 0;
  contextCounter = 0;
  requestCounter = 0;
  networkIdleTimer = null;
}

// ---------------------------------------------------------------------------
// CDP Helpers
// ---------------------------------------------------------------------------

/**
 * Send a CDP command to the attached tab.
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<any>}
 */
function cdpSend(method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: activeTabId }, method, params, (result) => {
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
  const IGNORED_ROLES = new Set([
    'none', 'presentation', 'generic', 'InlineTextBox', 'LineBreak',
    'ScrollArea', 'unknown',
  ]);

  for (const node of nodes) {
    const role = node.role && node.role.value;
    if (!role || IGNORED_ROLES.has(role)) continue;

    const name = node.name && node.name.value ? node.name.value.trim() : '';
    const description = node.description && node.description.value
      ? node.description.value.trim() : '';

    if (!name && !description) continue;

    const label = name || description;
    lines.push(`[${role} '${label.slice(0, 100)}']`);
  }

  return lines.join(' \n ');
}

// ---------------------------------------------------------------------------
// Network Event Handlers
// ---------------------------------------------------------------------------

function handleRequestWillBeSent(params) {
  if (!shouldCaptureByType(params.type, params.request.url)) return;

  const reqId = nextRequestId();
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
    endTime: null,
  };
  pendingRequests.set(params.requestId, entry);
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
}

async function handleLoadingFinished(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;
  entry.endTime = params.timestamp;

  // For SSE entries, the body is the accumulated events — skip CDP body fetch
  if (entry.entryType === 'sse') {
    pendingRequests.delete(params.requestId);
    completedRequests.set(params.requestId, entry);
    associateRequestWithActions(entry);
    scheduleNetworkIdleCheck();
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

  // Associate with open action windows
  associateRequestWithActions(entry);

  // Reset the network-idle timer
  scheduleNetworkIdleCheck();
}

// ---------------------------------------------------------------------------
// WebSocket Event Handlers
// ---------------------------------------------------------------------------

/**
 * A new WebSocket connection has been created.
 * CDP fires this before the HTTP upgrade handshake.
 */
function handleWebSocketCreated(params) {
  const reqId = nextRequestId();
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
    startTime: Date.now() / 1000, // Network.webSocketCreated does not carry a CDP timestamp
    endTime: null,
    wsMessages: [],
  };
  pendingWebSockets.set(params.requestId, entry);
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
}

/**
 * The WebSocket connection has been closed.
 */
function handleWebSocketClosed(params) {
  const entry = pendingWebSockets.get(params.requestId);
  if (!entry) return;

  entry.endTime = params.timestamp;
  pendingWebSockets.delete(params.requestId);
  completedRequests.set(params.requestId, entry);

  // Associate with open action windows
  associateRequestWithActions(entry);

  // Reset the network-idle timer
  scheduleNetworkIdleCheck();

  console.log('[WebTape] WebSocket closed:', entry.url,
    '— messages:', entry.wsMessages.length);
}

// ---------------------------------------------------------------------------
// Sliding Window Context Aggregation
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
 * @property {number|null} endTime
 * @property {Array<{timestamp:number, event:string, id:string, data:string}>} [sseEvents]
 * @property {Array<{timestamp:number, direction:'sent'|'received', opcode:number, data:string}>} [wsMessages]
 */

/**
 * @typedef {Object} PendingAction
 * @property {Object} action
 * @property {number} openUntil  - performance.now() deadline
 * @property {NetworkEntry[]} collectedRequests
 * @property {string} contextId
 */

/**
 * @typedef {Object} ContextBlock
 * @property {string} context_id
 * @property {number} timestamp
 * @property {Object} [state]
 * @property {Object} [action]
 * @property {Array}  [triggered_network]
 * @property {string} [post_action_a11y_tree_summary]
 */

function associateRequestWithActions(entry) {
  const now = performance.now();
  for (const pa of pendingActions) {
    if (now <= pa.openUntil) {
      pa.collectedRequests.push(entry);
    }
  }
}

/**
 * Receive a user action from the content script, open a sliding window,
 * and push a new context block placeholder to the timeline.
 */
function handleUserAction(payload) {
  if (recorderState !== 'recording') return;

  const contextId = nextContextId();
  const now = performance.now();

  /** @type {PendingAction} */
  const pendingAction = {
    action: {
      type: payload.actionType,
      target_element: payload.targetDescriptor,
      tag: payload.tagName,
      id: payload.id,
      aria_label: payload.ariaLabel,
    },
    openUntil: now + ACTION_WINDOW_MS,
    collectedRequests: [],
    contextId,
  };

  // Also sweep already-completed requests that fall within this window.
  // CDP startTime is in seconds since epoch; convert to ms for comparison.
  const windowStartMs = Date.now() - ACTION_WINDOW_MS;
  for (const entry of completedRequests.values()) {
    if (entry.startTime * 1000 >= windowStartMs) {
      pendingAction.collectedRequests.push(entry);
    }
  }

  pendingActions.push(pendingAction);

  /** @type {ContextBlock} */
  const block = {
    context_id: contextId,
    timestamp: Date.now(),
    action: pendingAction.action,
    triggered_network: null, // filled in later
    post_action_a11y_tree_summary: null, // filled in later
  };
  timeline.push(block);

  // Schedule finalisation after window closes
  setTimeout(() => finaliseAction(pendingAction, block), ACTION_WINDOW_MS + 100);
}

/**
 * After the sliding window closes, populate the context block with collected
 * network entries, then wait for network idle before capturing A11y.
 */
async function finaliseAction(pendingAction, block) {
  // Remove from pending list
  const idx = pendingActions.indexOf(pendingAction);
  if (idx !== -1) pendingActions.splice(idx, 1);

  // Populate triggered_network
  block.triggered_network = pendingAction.collectedRequests.map(toNetworkSummary);
}

function toNetworkSummary(entry) {
  const summary = {
    req_id: entry.reqId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    type: entry.entryType || 'http',
    detail_path: {
      request: `requests/${entry.reqId}_body.json`,
      response: `responses/${entry.reqId}_res.json`,
    },
  };
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
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Recording Lifecycle
// ---------------------------------------------------------------------------

async function startRecording(tabId, refreshFirst) {
  console.log('[WebTape] startRecording called — tabId:', tabId, ', refreshFirst:', refreshFirst);

  if (recorderState !== 'idle') {
    console.error('[WebTape] startRecording: already in state', recorderState);
    throw new Error('Recording already in progress.');
  }

  resetSession();
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
      // Enable Page domain to receive loadEventFired
      cdpSend('Page.enable', {}).then(() => {
        chrome.tabs.reload(tabId);
      });
    });
  }

  // Gather basic page info and initial A11y snapshot
  console.log('[WebTape] Capturing initial page info and A11y snapshot…');
  const tab = await chrome.tabs.get(tabId);
  const initialA11y = await captureA11ySummary();
  timeline.push({
    context_id: nextContextId(),
    timestamp: Date.now(),
    state: {
      type: 'INITIAL_LOAD',
      url: tab.url || '',
      title: tab.title || '',
      fav_icon_url: tab.favIconUrl || '',
      a11y_tree_summary: initialA11y,
    },
  });
  console.log('[WebTape] Recording started successfully.');
}

async function stopAndExport() {
  console.log('[WebTape] stopAndExport called, current state:', recorderState);

  if (recorderState !== 'recording') {
    console.error('[WebTape] stopAndExport: not in recording state, aborting.');
    throw new Error('Not recording.');
  }

  recorderState = 'packing';

  // Load settings
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get('webtapeSettings', (result) => {
      resolve(result.webtapeSettings || { exportMode: 'download', webhookUrl: 'http://localhost:5643/webhook' });
    });
  });
  const exportMode = settings.exportMode || 'download';

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
      sourceMap.delete(cdpId);
      completedRequests.set(cdpId, entry);
      console.log(`[WebTape] Finalised open ${entry.entryType}:`, entry.url);
    }
  };

  finalizeOpenEntries(pendingRequests, (e) => e.entryType === 'sse');
  finalizeOpenEntries(pendingWebSockets);

  const allRequests = [...completedRequests.values()];

  // Level 1: index.json (skeleton only)
  const indexData = timeline.map((block) => {
    const entry = { context_id: block.context_id, timestamp: block.timestamp };
    if (block.state) {
      entry.state = block.state;
    }
    if (block.action) {
      entry.action = block.action;
    }
    if (block.triggered_network) {
      entry.triggered_network = block.triggered_network;
    }
    if (block.post_action_a11y_tree_summary !== undefined) {
      entry.post_action_a11y_tree_summary = block.post_action_a11y_tree_summary;
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
    const reqPayload = {
      req_id: entry.reqId,
      type: entry.entryType || 'http',
      method: entry.method,
      url: entry.url,
      headers: entry.requestHeaders,
      body: tryParseJson(entry.requestBody),
    };
    requestsData[`${entry.reqId}_body.json`] = reqPayload;

    // Build response payload based on entry type
    const resPayload = {
      req_id: entry.reqId,
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

    responsesData[`${entry.reqId}_res.json`] = resPayload;
  }

  try {
    // Extract hostname from the first timeline entry's URL (shared by both export modes)
    let siteHostname = '';
    try {
      const siteUrl = indexData && indexData.length > 0 && indexData[0].state && indexData[0].state.url;
      if (siteUrl) {
        siteHostname = new URL(siteUrl).hostname;
      }
    } catch (_e) { /* ignore */ }

    if (exportMode === 'webhook') {
      // Webhook: send full data as JSON POST
      const webhookUrlStr = (settings.webhookUrl || '').trim();
      if (!webhookUrlStr) {
        throw new Error('Webhook URL is not configured.');
      }

      // Validate URL format
      let parsedUrl;
      try {
        parsedUrl = new URL(webhookUrlStr);
      } catch (_e) {
        throw new Error('Webhook URL is not a valid URL: ' + webhookUrlStr);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('Webhook URL must use http or https protocol.');
      }

      const now = new Date();
      const payload = {
        meta: {
          timestamp: now.toISOString(),
          epoch: now.getTime(),
          version: chrome.runtime.getManifest().version,
          source: 'WebTape',
          hostname: siteHostname || undefined,
        },
        content: {
          'index.json': indexData,
          requests: requestsData,
          responses: responsesData,
        },
      };

      console.log('[WebTape] Sending webhook to:', webhookUrlStr);
      let resp;
      try {
        resp = await fetch(webhookUrlStr, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (fetchErr) {
        throw new Error(
          'Failed to connect to webhook at ' + webhookUrlStr + ': ' + fetchErr.message +
          '. Check that the URL is correct and the server is running.'
        );
      }

      if (!resp.ok) {
        throw new Error('Webhook request failed: ' + resp.status + ' ' + resp.statusText);
      }
      console.log('[WebTape] Webhook sent successfully, status:', resp.status);
    } else {
      // Download: build ZIP and trigger download
      const zip = new JSZip();
      zip.file('index.json', JSON.stringify(indexData, null, 2));

      const reqFolder = zip.folder('requests');
      const resFolder = zip.folder('responses');

      for (const [filename, data] of Object.entries(requestsData)) {
        reqFolder.file(filename, JSON.stringify(data, null, 2));
      }
      for (const [filename, data] of Object.entries(responsesData)) {
        resFolder.file(filename, JSON.stringify(data, null, 2));
      }

      console.log('[WebTape] Generating ZIP archive…');
      const base64 = await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
      console.log('[WebTape] ZIP generated, base64 length:', base64.length);

      const dataUrl = 'data:application/zip;base64,' + base64;

      const domain = siteHostname || 'unknown';

      const now = new Date();
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      const datePart = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const filename = `${domain}-${datePart}-${timePart}.zip`;

      console.log('[WebTape] Starting download:', filename);

      await new Promise((resolve, reject) => {
        chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('[WebTape] Download failed:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            console.log('[WebTape] Download started, id:', downloadId);
            resolve(downloadId);
          }
        });
      });
    }
  } catch (err) {
    resetSession();
    activeTabId = null;
    recorderState = 'idle';
    throw err;
  }

  resetSession();
  activeTabId = null;
  recorderState = 'idle';
  console.log('[WebTape] Export complete, session reset.');
  return { exportMode };
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

  if (type === 'STOP_EXPORT') {
    stopAndExport()
      .then((result) => sendResponse({ ok: true, exportMode: result.exportMode }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  return false;
});
