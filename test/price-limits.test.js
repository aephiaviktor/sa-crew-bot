const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { normalizeOrderPrices, parseOrderPriceRange } = require('../electron/lib/order-price-limits');
const { computeTargetCrewBidLamports } = require('../dist/tensor_market');

test('legacy global minimum migrates into rows without a per-order minimum', () => {
  assert.deepEqual(normalizeOrderPrices({ maxBidSol: '0.008' }, '0.001'), {
    minBidSol: '0.001',
    maxBidSol: '0.008',
  });
  assert.equal(normalizeOrderPrices({ minBidSol: '', maxBidSol: '' }, '0.001').minBidSol, '');
});

test('blank price limits parse as unbounded and reject inverted ranges', () => {
  assert.deepEqual(parseOrderPriceRange('', ''), { minBidSol: null, maxBidSol: null });
  assert.deepEqual(parseOrderPriceRange('0.001', ''), { minBidSol: 0.001, maxBidSol: null });
  assert.deepEqual(parseOrderPriceRange('', '0.008'), { minBidSol: null, maxBidSol: 0.008 });
  assert.throws(() => parseOrderPriceRange('0.009', '0.008'), /Min price cannot exceed Max price/);
});

test('unbounded target follows competition and starts at one bid step without competition', () => {
  assert.equal(computeTargetCrewBidLamports({
    bestCompetingBidLamports: 100,
    minBidLamports: null,
    maxBidLamports: null,
    bidStepLamports: 10,
    bestAskLamports: null,
  }), 110);
  assert.equal(computeTargetCrewBidLamports({
    bestCompetingBidLamports: null,
    minBidLamports: null,
    maxBidLamports: null,
    bidStepLamports: 10,
    bestAskLamports: null,
  }), 10);
});

test('one-sided bounds and unreachable competing bids remain correct', () => {
  assert.equal(computeTargetCrewBidLamports({
    bestCompetingBidLamports: 100,
    competingBidLamports: [120, 90],
    minBidLamports: null,
    maxBidLamports: 110,
    bidStepLamports: 10,
    bestAskLamports: null,
  }), 100);
  assert.equal(computeTargetCrewBidLamports({
    bestCompetingBidLamports: null,
    minBidLamports: 50,
    maxBidLamports: null,
    bidStepLamports: 10,
    bestAskLamports: null,
  }), 50);
});

test('limit-order UI uses per-row Min price and Max price columns with SOL hints', async () => {
  const root = path.join(__dirname, '..');
  const html = await fs.readFile(path.join(root, 'electron', 'renderer.html'), 'utf8');
  const renderer = await fs.readFile(path.join(root, 'electron', 'renderer.js'), 'utf8');

  assert.match(html, /<th>Min price<\/th>\s*<th>Max price<\/th>/);
  assert.doesNotMatch(html, /Min Bid SOL/);
  assert.match(renderer, /data-field="minBidSol"[\s\S]*?<span class="cell-hint">SOL<\/span>/);
  assert.match(renderer, /data-field="maxBidSol"[\s\S]*?<span class="cell-hint">SOL<\/span>/);
});
