'use strict';

(function () {
  // Avoid injecting multiple times
  if (window.__webTapeInjected) return;
  window.__webTapeInjected = true;

  /**
   * Extracts a concise descriptor for a DOM element to send with action events.
   * @param {Element} el
   * @returns {string}
   */
  function describeElement(el) {
    if (!el) return 'unknown';
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    const id = el.id ? `#${el.id}` : '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const text = (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80);
    const role = el.getAttribute('role') || '';
    const type = el.getAttribute('type') || '';

    const parts = [tag];
    if (id) parts.push(id);
    if (role) parts.push(`[role="${role}"]`);
    if (type) parts.push(`[type="${type}"]`);
    if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`);
    if (text) parts.push(`"${text}"`);

    return parts.join(' ');
  }

  /**
   * Send a captured action event to the background service worker.
   * @param {string} actionType
   * @param {Element} target
   * @param {Object} [extra]
   */
  function sendAction(actionType, target, extra) {
    const descriptor = describeElement(target);
    const message = {
      type: 'USER_ACTION',
      payload: {
        actionType,
        targetDescriptor: descriptor,
        tagName: target ? target.tagName : '',
        id: target ? target.id : '',
        ariaLabel: target ? (target.getAttribute('aria-label') || '') : '',
        innerText: target ? (target.innerText || '').trim().slice(0, 200) : '',
        timestamp: performance.now(),
        ...extra,
      },
    };
    chrome.runtime.sendMessage(message).catch(() => {
      // Extension context may be invalidated on navigation; ignore silently.
    });
  }

  // ---------- Event Listeners ----------

  document.addEventListener('click', (e) => {
    sendAction('CLICK', e.target);
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    const extra = {};
    if (el.type === 'checkbox' || el.type === 'radio') {
      extra.checked = el.checked;
    } else {
      extra.value = (el.value || '').slice(0, 200);
    }
    sendAction('CHANGE', el, extra);
  }, true);

  document.addEventListener('keydown', (e) => {
    // Only capture significant keys to reduce noise
    const SIGNIFICANT_KEYS = new Set([
      'Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    ]);
    if (SIGNIFICANT_KEYS.has(e.key)) {
      sendAction('KEYDOWN', e.target, { key: e.key });
    }
  }, true);

  document.addEventListener('submit', (e) => {
    sendAction('SUBMIT', e.target);
  }, true);
})();
