function normalizeOptionalPrice(value, fallback = '') {
  if (value === undefined || value === null) return String(fallback ?? '').trim();
  return String(value).trim();
}

function normalizeOrderPrices(row = {}, legacyMinBidSol = '', fallbackMaxBidSol = '') {
  return {
    minBidSol: normalizeOptionalPrice(row.minBidSol ?? row.MIN_BID_SOL, legacyMinBidSol),
    maxBidSol: normalizeOptionalPrice(row.maxBidSol ?? row.MAX_BID_SOL, fallbackMaxBidSol),
  };
}

function parseOptionalPositivePrice(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive SOL amount or empty.`);
  return parsed;
}

function parseOrderPriceRange(minValue, maxValue) {
  const minBidSol = parseOptionalPositivePrice(minValue, 'Min price');
  const maxBidSol = parseOptionalPositivePrice(maxValue, 'Max price');
  if (minBidSol !== null && maxBidSol !== null && minBidSol > maxBidSol) {
    throw new Error('Min price cannot exceed Max price.');
  }
  return { minBidSol, maxBidSol };
}

module.exports = { normalizeOrderPrices, parseOrderPriceRange };
