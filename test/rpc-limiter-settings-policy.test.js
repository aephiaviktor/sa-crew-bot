'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyRpcLimiterSettings,
  resolveLimiterConnectionUrls,
  resolveProviderRole,
} = require('../electron/lib/rpc-limiter-settings-policy');

function stateFixture() {
  return {
    version: 2,
    enabled: true,
    rpcBaseUrl: 'https://legacy.invalid',
    apiKey: 'legacy-value',
    providers: {
      main: { rpcBaseUrl: 'https://main.invalid', apiKey: 'main-value', failures: 2, cooldownUntilMs: 100 },
      fallback: { rpcBaseUrl: 'https://fallback.invalid', apiKey: 'fallback-value', failures: 1, cooldownUntilMs: 200 },
    },
    providersRoundRobinCounter: 7,
    buckets: {
      'rpc:shared': { nextSlotMs: 1234, intervalMs: 250 },
      'tx:shared': { nextSlotMs: 5678, intervalMs: 1000 },
    },
    limits: { failureThreshold: 3 },
    exclusive: { bucket: 'fleet:aggressive' },
    revision: 9,
  };
}

test('only literal fallback selects the Fallback slot', () => {
  assert.equal(resolveProviderRole('fallback'), 'fallback');
  for (const value of [undefined, null, '', 'main', 'true', true, false, 'unexpected']) {
    assert.equal(resolveProviderRole(value), 'main');
  }
});

test('provider update preserves the other provider and shared coordination state', () => {
  const state = stateFixture();
  const fallback = structuredClone(state.providers.fallback);
  const exclusive = structuredClone(state.exclusive);

  assert.deepEqual(applyRpcLimiterSettings(state, {
    providerRole: 'main',
    rpcUrl: 'https://replacement.invalid/?api-key=placeholder',
    rpcRequestsPerSecond: '8',
    txRequestsPerSecond: '2',
  }), { role: 'main', action: 'updated' });

  assert.equal(state.providers.main.rpcBaseUrl, 'https://replacement.invalid');
  assert.equal(state.providers.main.failures, 0);
  assert.equal(state.providers.main.cooldownUntilMs, null);
  assert.deepEqual(state.providers.fallback, fallback);
  assert.deepEqual(state.exclusive, exclusive);
  assert.equal(state.buckets['rpc:shared'].nextSlotMs, 1234);
  assert.equal(state.buckets['rpc:shared'].intervalMs, 125);
  assert.equal(state.buckets['tx:shared'].intervalMs, 500);
});

test('blank input clears only the selected slot without validating or changing rates', () => {
  for (const rpcUrl of ['', '  \n ']) {
    const state = stateFixture();
    const main = structuredClone(state.providers.main);
    const buckets = structuredClone(state.buckets);

    assert.deepEqual(applyRpcLimiterSettings(state, {
      providerRole: 'fallback', rpcUrl, rpcRequestsPerSecond: 'invalid', txRequestsPerSecond: '',
    }), { role: 'fallback', action: 'cleared' });
    assert.deepEqual(state.providers.fallback, {});
    assert.deepEqual(state.providers.main, main);
    assert.deepEqual(state.buckets, buckets);
    assert.equal(state.enabled, true);
  }
});

test('clearing final Main removes legacy fields and disables shared state', () => {
  const state = stateFixture();
  state.providers.fallback = {};
  applyRpcLimiterSettings(state, { providerRole: 'main', rpcUrl: '' });
  assert.deepEqual(state.providers.main, {});
  assert.equal(Object.hasOwn(state, 'rpcBaseUrl'), false);
  assert.equal(Object.hasOwn(state, 'apiKey'), false);
  assert.equal(state.enabled, false);
});

test('invalid non-empty URL does not mutate state', () => {
  const state = stateFixture();
  const before = structuredClone(state);
  assert.throws(() => applyRpcLimiterSettings(state, {
    providerRole: 'fallback', rpcUrl: 'not a URL', rpcRequestsPerSecond: '10', txRequestsPerSecond: '1',
  }));
  assert.deepEqual(state, before);
});

test('limiter runtime supports Main-only, Fallback-only, both, and neither', () => {
  assert.deepEqual(resolveLimiterConnectionUrls({ main: { url: 'main' }, fallback: {} }), { rpcUrl: 'main', rpcUrlFallback: '' });
  assert.deepEqual(resolveLimiterConnectionUrls({ main: {}, fallback: { url: 'fallback' } }), { rpcUrl: 'fallback', rpcUrlFallback: '' });
  assert.deepEqual(resolveLimiterConnectionUrls({ main: { url: 'main' }, fallback: { url: 'fallback' } }), { rpcUrl: 'main', rpcUrlFallback: 'fallback' });
  assert.throws(() => resolveLimiterConnectionUrls({ main: {}, fallback: {} }), /no RPC Limiter URLs are configured/);
});
