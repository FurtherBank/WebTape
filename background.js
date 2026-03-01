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
  const reqId = nextRequestId();
  /** @type {NetworkEntry} */
  const entry = {
    reqId,
    cdpRequestId: params.requestId,
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
}

function handleResponseReceived(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;
  entry.status = params.response.status;
  entry.responseHeaders = params.response.headers;
  entry.mimeType = params.response.mimeType;
}

async function handleLoadingFinished(params) {
  const entry = pendingRequests.get(params.requestId);
  if (!entry) return;
  entry.endTime = params.timestamp;

  // Fetch response body
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
// Sliding Window Context Aggregation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} NetworkEntry
 * @property {string} reqId
 * @property {string} cdpRequestId
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
  return {
    req_id: entry.reqId,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    detail_path: {
      request: `requests/${entry.reqId}_body.json`,
      response: `responses/${entry.reqId}_res.json`,
    },
  };
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
  if (recorderState !== 'idle') {
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

  // Initial A11y snapshot
  const initialA11y = await captureA11ySummary();
  timeline.push({
    context_id: nextContextId(),
    timestamp: Date.now(),
    state: {
      type: 'INITIAL_LOAD',
      a11y_tree_summary: initialA11y,
    },
  });
}

async function stopAndExport() {
  if (recorderState !== 'recording') {
    throw new Error('Not recording.');
  }

  recorderState = 'packing';

  // Detach debugger
  if (activeTabId !== null) {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId: activeTabId }, () => {
        // Ignore errors (tab may have been closed)
        resolve();
      });
    });
  }

  // Build the ZIP
  const zip = new JSZip();
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
  zip.file('index.json', JSON.stringify(indexData, null, 2));

  // Level 2: requests/ and responses/
  const reqFolder = zip.folder('requests');
  const resFolder = zip.folder('responses');

  for (const entry of allRequests) {
    const reqPayload = {
      req_id: entry.reqId,
      method: entry.method,
      url: entry.url,
      headers: entry.requestHeaders,
      body: entry.requestBody,
    };
    reqFolder.file(`${entry.reqId}_body.json`, JSON.stringify(reqPayload, null, 2));

    const resPayload = {
      req_id: entry.reqId,
      status: entry.status,
      headers: entry.responseHeaders,
      mime_type: entry.mimeType,
      body: entry.responseBody,
    };
    resFolder.file(`${entry.reqId}_res.json`, JSON.stringify(resPayload, null, 2));
  }

  // Generate blob and trigger download
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `webtape_${datePart}_${timePart}.zip`;

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      URL.revokeObjectURL(url);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });

  resetSession();
  activeTabId = null;
  recorderState = 'idle';
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

  if (type === 'GET_STATE') {
    sendResponse({
      state: recorderState,
      stats: {
        actions: timeline.filter((b) => b.action).length,
        requests: completedRequests.size,
        contexts: timeline.length,
      },
    });
    return false;
  }

  if (type === 'GET_STATS') {
    sendResponse({
      actions: timeline.filter((b) => b.action).length,
      requests: completedRequests.size,
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
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async
  }

  return false;
});
