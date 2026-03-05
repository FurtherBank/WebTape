'use strict';

const btnDirectRecord = document.getElementById('btnDirectRecord');
const btnRefreshRecord = document.getElementById('btnRefreshRecord');
const btnStop = document.getElementById('btnStop');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statActions = document.getElementById('statActions');
const statRequests = document.getElementById('statRequests');
const statContexts = document.getElementById('statContexts');
const messageEl = document.getElementById('message');
const settingsToggle = document.getElementById('settingsToggle');
const settingsBody = document.getElementById('settingsBody');
const settingsArrow = document.getElementById('settingsArrow');
const exportMode = document.getElementById('exportMode');
const webhookRow = document.getElementById('webhookRow');
const webhookUrl = document.getElementById('webhookUrl');

let statsInterval = null;

function setStatus(state, text) {
  statusDot.className = 'status-dot ' + state;
  statusText.textContent = text;
}

function setMessage(msg, type) {
  messageEl.textContent = msg;
  messageEl.className = 'message' + (type ? ' ' + type : '');
}

function setRecordingUI(recording) {
  btnDirectRecord.disabled = recording;
  btnRefreshRecord.disabled = recording;
  btnStop.disabled = !recording;
}

function refreshStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    statActions.textContent = resp.actions || 0;
    statRequests.textContent = resp.requests || 0;
    statContexts.textContent = resp.contexts || 0;
  });
}

function startStatsPolling() {
  refreshStats();
  statsInterval = setInterval(refreshStats, 1000);
}

function stopStatsPolling() {
  if (statsInterval !== null) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

btnDirectRecord.addEventListener('click', async () => {
  setMessage('');
  const tab = await getCurrentTab();
  if (!tab) {
    setMessage('No active tab found.', 'error');
    return;
  }
  chrome.runtime.sendMessage({ type: 'START_DIRECT', tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) {
      setMessage(chrome.runtime.lastError.message, 'error');
      return;
    }
    if (resp && resp.error) {
      setMessage(resp.error, 'error');
      return;
    }
    setStatus('recording', 'Recording…');
    setRecordingUI(true);
    setMessage('Direct recording started.');
    startStatsPolling();
  });
});

btnRefreshRecord.addEventListener('click', async () => {
  setMessage('');
  const tab = await getCurrentTab();
  if (!tab) {
    setMessage('No active tab found.', 'error');
    return;
  }
  chrome.runtime.sendMessage({ type: 'START_REFRESH', tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) {
      setMessage(chrome.runtime.lastError.message, 'error');
      return;
    }
    if (resp && resp.error) {
      setMessage(resp.error, 'error');
      return;
    }
    setStatus('recording', 'Reloading…');
    setRecordingUI(true);
    setMessage('Refresh recording started.');
    startStatsPolling();
  });
});

btnStop.addEventListener('click', async () => {
  setMessage('');
  stopStatsPolling();
  setStatus('packing', 'Packing…');
  btnStop.disabled = true;

  chrome.runtime.sendMessage({ type: 'STOP_EXPORT' }, (resp) => {
    if (chrome.runtime.lastError) {
      setMessage(chrome.runtime.lastError.message, 'error');
      setStatus('idle', 'Idle');
      setRecordingUI(false);
      return;
    }
    if (resp && resp.error) {
      setMessage(resp.error, 'error');
      setStatus('idle', 'Idle');
      setRecordingUI(false);
      return;
    }
    setStatus('idle', 'Idle');
    setRecordingUI(false);
    refreshStats();
    if (resp.exportMode === 'webhook') {
      setMessage('Export complete! Data sent via webhook.', 'success');
    } else {
      setMessage('Export complete! ZIP downloaded.', 'success');
    }
  });
});

// Sync UI state on popup open
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
  if (chrome.runtime.lastError || !resp) return;
  if (resp.state === 'recording') {
    setStatus('recording', 'Recording…');
    setRecordingUI(true);
    startStatsPolling();
  } else if (resp.state === 'packing') {
    setStatus('packing', 'Packing…');
    btnStop.disabled = true;
    btnDirectRecord.disabled = true;
    btnRefreshRecord.disabled = true;
  } else {
    setStatus('idle', 'Idle');
    setRecordingUI(false);
  }
  if (resp.stats) {
    statActions.textContent = resp.stats.actions || 0;
    statRequests.textContent = resp.stats.requests || 0;
    statContexts.textContent = resp.stats.contexts || 0;
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function updateWebhookRowVisibility() {
  webhookRow.style.display = exportMode.value === 'webhook' ? '' : 'none';
}

function saveSettings() {
  const settings = {
    exportMode: exportMode.value,
    webhookUrl: webhookUrl.value.trim(),
  };
  chrome.storage.local.set({ webtapeSettings: settings });
}

settingsToggle.addEventListener('click', () => {
  const isHidden = settingsBody.style.display === 'none';
  settingsBody.style.display = isHidden ? '' : 'none';
  settingsArrow.classList.toggle('open', isHidden);
});

exportMode.addEventListener('change', () => {
  updateWebhookRowVisibility();
  saveSettings();
});

webhookUrl.addEventListener('input', () => {
  saveSettings();
});

// Load persisted settings
chrome.storage.local.get('webtapeSettings', (result) => {
  const s = result.webtapeSettings;
  if (!s) return;
  if (s.exportMode) exportMode.value = s.exportMode;
  if (s.webhookUrl) webhookUrl.value = s.webhookUrl;
  updateWebhookRowVisibility();
});
