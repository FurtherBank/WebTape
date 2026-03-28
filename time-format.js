'use strict';

/**
 * Format epoch milliseconds as Asia/Shanghai (+08:00) wall time with ms precision.
 * @param {number} epochMs
 * @returns {string} e.g. 2026-03-28T15:30:45.123+08:00
 */
function formatTimestampCST(epochMs) {
  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  }).formatToParts(d);

  const g = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };

  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+08:00`;
}

// Service worker & shared page scripts
self.WebTapeTime = { formatTimestampCST };
