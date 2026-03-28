'use strict';

(function launch() {
  const statusEl = document.getElementById('status');

  function fail(msg) {
    if (statusEl) statusEl.textContent = msg;
    else console.error(msg);
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

  chrome.runtime.sendMessage(
    { type: 'SCHEME_START_RECORDING', url: target },
    (resp) => {
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
    },
  );
})();
