'use strict';

(function launch() {
  const statusEl = document.getElementById('status');

  function fail(msg) {
    if (statusEl) statusEl.textContent = msg;
    else console.error(msg);
  }

  /** @param {URLSearchParams} sp */
  function parseExportFromParams(sp) {
    const modeRaw = (sp.get('export') || sp.get('exportMode') || '').trim().toLowerCase();
    const webhook = (sp.get('webhook') || sp.get('webhookUrl') || '').trim();
    if (!modeRaw && !webhook) return null;
    let exportMode = modeRaw;
    if (exportMode === 'zip') exportMode = 'download';
    if (!exportMode && webhook) exportMode = 'webhook';
    if (exportMode !== 'download' && exportMode !== 'webhook') return null;
    /** @type {{ exportMode: string, webhookUrl?: string }} */
    const o = { exportMode };
    if (webhook) o.webhookUrl = webhook;
    return o;
  }

  /** @param {string | null | undefined} raw */
  function tryParseExportFromUrlString(raw) {
    const t = (raw || '').trim();
    if (!t) return null;
    try {
      const u = new URL(t);
      return parseExportFromParams(u.searchParams);
    } catch {
      return null;
    }
  }

  /** @param {{ exportMode?: string, webhookUrl?: string } | null} a @param {{ exportMode?: string, webhookUrl?: string } | null} b */
  function mergeExport(a, b) {
    if (!a) return b;
    if (!b) return a;
    const wh = (b.webhookUrl || a.webhookUrl || '').trim();
    /** @type {{ exportMode: string, webhookUrl?: string }} */
    const o = { exportMode: /** @type {string} */ (b.exportMode || a.exportMode) };
    if (wh) o.webhookUrl = wh;
    return o;
  }

  /** @param {string} raw */
  function resolveTargetUrl(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    try {
      const outer = new URL(trimmed);
      const fromParam = outer.searchParams.get('url') || outer.searchParams.get('target');
      if (fromParam) return decodeURIComponent(fromParam);
      if (outer.protocol === 'web+webtape:' && outer.hostname) {
        const path = outer.pathname.replace(/^\//, '');
        if (path && /^https?:\/\//i.test(path)) return path;
      }
    } catch {
      /* fall through */
    }

    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  }

  const params = new URLSearchParams(window.location.search || '');
  const nav = params.get('nav');
  const direct = params.get('url') || params.get('target');

  let sessionExport = parseExportFromParams(params);
  sessionExport = mergeExport(sessionExport, tryParseExportFromUrlString(direct || ''));
  if (nav) {
    try {
      const decoded = decodeURIComponent(nav);
      sessionExport = mergeExport(sessionExport, tryParseExportFromUrlString(decoded));
    } catch {
      sessionExport = mergeExport(sessionExport, tryParseExportFromUrlString(nav));
    }
  }

  let target = resolveTargetUrl(direct || '');
  if (!target && nav) {
    try {
      const decoded = decodeURIComponent(nav);
      target = resolveTargetUrl(decoded);
    } catch {
      target = resolveTargetUrl(nav);
    }
  }

  if (!target) {
    fail('缺少目标网址：请使用 record-launcher.html?url=https://example.com 或 web+webtape://open?url=…');
    return;
  }

  /** @type {{ type: string, url: string, sessionExport?: Record<string, string> }} */
  const msg = { type: 'SCHEME_START_RECORDING', url: target };
  if (sessionExport) msg.sessionExport = sessionExport;

  chrome.runtime.sendMessage(msg, (resp) => {
    if (chrome.runtime.lastError) {
      fail(chrome.runtime.lastError.message);
      return;
    }
    if (resp && resp.error) {
      fail(resp.error);
      return;
    }
    if (statusEl) statusEl.textContent = '已开始录制，可关闭本页。';
    window.setTimeout(() => window.close(), 800);
  });
})();
