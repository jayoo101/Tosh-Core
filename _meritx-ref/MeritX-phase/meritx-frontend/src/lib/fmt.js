/**
 * Format an ETH value to a fixed number of decimal places.
 * Accepts number or string. Returns string like "0.0150".
 */
export function fmtEth(value, decimals = 4) {
  const num = Number(value) || 0;
  return num.toFixed(decimals);
}

/**
 * Smart ETH formatter that never rounds to "0" for non-zero values.
 * Uses `decimals` if the result is non-zero, otherwise auto-detects
 * sufficient precision (up to 6 digits).
 */
export function fmtEthSmart(value, preferredDecimals = 2) {
  const num = Number(value) || 0;
  if (num === 0) return '0';
  const result = num.toFixed(preferredDecimals);
  if (parseFloat(result) !== 0) return result;
  for (let d = preferredDecimals + 1; d <= 6; d++) {
    const r = num.toFixed(d);
    if (parseFloat(r) !== 0) return r;
  }
  return num.toFixed(6);
}

/**
 * Truncate an address to 0x1234...ABCD format.
 * @param {string} addr - Full address
 * @param {number} start - Characters to keep from start (default 6, includes 0x)
 * @param {number} end - Characters to keep from end (default 4)
 */
export function truncAddr(addr, start = 6, end = 4) {
  if (!addr || addr.length < start + end + 3) return addr || '';
  return `${addr.slice(0, start)}...${addr.slice(-end)}`;
}

/**
 * Format a timestamp (ms or Date) to strict UTC: "2026-04-11 15:28 UTC"
 * Immune to browser timezone. Designed for on-chain time display.
 */
export function fmtUTC(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi} UTC`;
}
