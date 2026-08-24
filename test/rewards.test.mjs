// STAKING REWARD AUTO-CONVERSION — the extension's engine.
//
// The decisions themselves (which coins are rewards, which batches convert) are
// SWK's and are tested in Rust. What is tested here is the ORCHESTRATION, where
// the expensive mistakes live: selling the same reward twice, releasing coins
// after an ambiguous failure, or converting at all while the setting is off.

import test from 'node:test';
import assert from 'node:assert/strict';

// chrome.storage stand-in, installed before the module under test loads.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
      async set(o) { for (const [k, v] of Object.entries(o)) store.set(k, v); },
      async remove(key) { store.delete(key); },
    },
  },
};

const {
  rewardSettings, setRewardSettings, runAutoConvert, conversions,
  convertedOutpoints, sliceForWholeHtlc, totalsOf, NATIVE_BTC, DEFAULT_SETTINGS,
} = await import('../src/rewards.js');

const GOLD = 'aa'.repeat(32);
const USDX = 'bb'.repeat(32);

function fakeEngine({ rewards = [], batches = [], decision = null } = {}) {
  const calls = { plan: 0, decide: 0, lastAlready: null, lastSettings: null };
  return {
    calls,
    attributeStakingRewards: () => rewards,
    planRewardBatches(_r, settingsJson, alreadyJson) {
      calls.plan++;
      calls.lastAlready = JSON.parse(alreadyJson);
      calls.lastSettings = JSON.parse(settingsJson);
      return batches;
    },
    decideRewardConversion() { calls.decide++; return decision; },
  };
}

function ctxFor(engine, execute) {
  const executed = [];
  return {
    executed,
    ctx: {
      engine,
      walletTxs: () => [],
      stakingKeys: () => [],
      tipHeight: () => 100,
      quoteFor: async () => ({ receives: 50000, reference: 50000 }),
      execute: execute || (async (plan) => { executed.push(plan); return { ok: true, txid: 'tx1' }; }),
    },
  };
}

test.beforeEach(() => store.clear());

test('the setting is off by default, and nothing converts while it is', async () => {
  const engine = fakeEngine({ batches: [{ asset: GOLD, inputs: ['t:0'], value: 1000 }], decision: { converts: true, receives: 50000 } });
  const { ctx, executed } = ctxFor(engine);

  const s = await rewardSettings();
  assert.equal(s.enabled, false, 'opt-in, always');
  assert.equal(s.target, NATIVE_BTC, 'Bitcoin is the default target');

  const r = await runAutoConvert(ctx);
  assert.equal(r.ran, false);
  assert.equal(executed.length, 0);
  assert.equal(engine.calls.plan, 0, 'a disabled engine does not even plan');
});

test('an enabled pass converts a batch the engine approves', async () => {
  const engine = fakeEngine({
    batches: [{ asset: GOLD, inputs: ['t1:0'], value: 1000 }],
    decision: { converts: true, receives: 50000 },
  });
  const { ctx, executed } = ctxFor(engine);
  await setRewardSettings({ enabled: true });

  const r = await runAutoConvert(ctx);
  assert.equal(r.converted.length, 1);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].asset, GOLD);
  assert.equal(executed[0].target, NATIVE_BTC);
  assert.equal((await conversions())[0].state, 'done');
});

test('a converted reward is never offered again', async () => {
  const engine = fakeEngine({
    batches: [{ asset: GOLD, inputs: ['t1:0'], value: 1000 }],
    decision: { converts: true, receives: 50000 },
  });
  const { ctx } = ctxFor(engine);
  await setRewardSettings({ enabled: true });

  await runAutoConvert(ctx);
  await runAutoConvert(ctx);
  assert.deepEqual(engine.calls.lastAlready, ['t1:0']);
});

test('a definite refusal releases the coins; an ambiguous one does not', async () => {
  const engine = fakeEngine({
    batches: [{ asset: GOLD, inputs: ['t1:0'], value: 1000 }],
    decision: { converts: true, receives: 50000 },
  });

  const refuse = ctxFor(engine, async () => ({ ok: false, error: 'no route' }));
  await setRewardSettings({ enabled: true });
  await runAutoConvert(refuse.ctx);
  assert.equal((await conversions())[0].state, 'failed');
  assert.deepEqual(await convertedOutpoints(), [], 'the sale did not happen, so the coins are free');

  store.clear();
  await setRewardSettings({ enabled: true });
  const thrown = ctxFor(engine, async () => { throw new Error('connection lost'); });
  await runAutoConvert(thrown.ctx);
  assert.equal((await conversions())[0].state, 'pending');
  assert.deepEqual(await convertedOutpoints(), ['t1:0'], 'it may have paid before it threw');
});

test('a chosen non-BTC target reaches the engine as an asset id', async () => {
  const engine = fakeEngine({ batches: [] });
  const { ctx } = ctxFor(engine);
  await setRewardSettings({ enabled: true, target: USDX });
  await runAutoConvert(ctx);
  assert.equal(engine.calls.lastSettings.target, USDX);

  await setRewardSettings({ target: NATIVE_BTC });
  await runAutoConvert(ctx);
  assert.equal(engine.calls.lastSettings.target, null, 'native BTC is how SWK spells no asset id');
});

test('settings round-trip and keep their defaults', async () => {
  await setRewardSettings({ enabled: true, maxSlippageBp: 50 });
  const s = await rewardSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.maxSlippageBp, 50);
  assert.equal(s.minReceive, DEFAULT_SETTINGS.minReceive);
});

test('a whole-HTLC offer is clamped to the batch, never the other way round', () => {
  assert.equal(sliceForWholeHtlc(5000n, 1000n), 1000n);
  assert.equal(sliceForWholeHtlc(600n, 1000n), 600n);
  assert.equal(sliceForWholeHtlc(0n, 1000n), 0n);
  assert.equal(sliceForWholeHtlc(5000n, 0n), 0n);
});

test('totals separate what is spendable from what is still maturing', () => {
  const t = totalsOf([
    { asset: GOLD, value: 100, mature: true, spent: false, source: 'solo' },
    { asset: GOLD, value: 250, mature: false, spent: false, source: 'solo' },
    { asset: GOLD, value: 999, mature: true, spent: true, source: 'solo' },
    { asset: USDX, value: 7, mature: true, spent: false, source: 'split' },
  ]);
  const gold = t.find((x) => x.asset === GOLD);
  assert.equal(gold.mature, 100n);
  assert.equal(gold.immature, 250n);
  assert.equal(gold.outputs, 3);
  assert.equal(t.find((x) => x.asset === USDX).sources.split, 1);
});
