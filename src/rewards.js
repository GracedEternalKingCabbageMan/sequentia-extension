// STAKING REWARD AUTO-CONVERSION — the extension's engine.
//
// A staker is paid the transaction fees of the blocks it earns from, and under
// the open fee market those arrive in whichever assets the payers chose. The
// result is a long tail of small balances in assets nobody chose to hold. This
// converts that tail into ONE asset the staker picked — native Bitcoin by
// default and first in the picker, but not the only choice, because outside
// staking no asset is privileged.
//
// The two decisions that must not differ between wallets — which coins are
// rewards, and which of them to sell — are NOT made here. They are made once in
// SWK (`lwk_wollet::staking_rewards`) and reached through the wasm bindings, so
// this extension, the web wallet and Ambra cannot drift apart about a staker's
// own coins. What lives here is the orchestration and this wallet's own rails.
//
// The specification is doc/sequentia/reward-autoconvert-design.md in the node
// repo.

import { stGet, stSet } from './util.js';

const SETTINGS_KEY = 'rewardAutoConvert';
const LEDGER_KEY = 'rewardConversions';

// Native parent-chain BTC is not an asset id, so it needs a sentinel. Never
// SBTC: a staker who asks for Bitcoin gets Bitcoin.
export const NATIVE_BTC = 'BTC';

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,          // opt-in, always: converting rewards is irreversible
  target: NATIVE_BTC,
  exclude: [],
  minReceive: '10000',     // atoms of the TARGET asset (0.0001 BTC)
  maxSlippageBp: 200,
});

export async function rewardSettings() {
  const s = (await stGet('local', SETTINGS_KEY, {})) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    exclude: Array.isArray(s.exclude) ? s.exclude.slice() : [],
    minReceive: String(s.minReceive ?? DEFAULT_SETTINGS.minReceive),
    maxSlippageBp: Number(s.maxSlippageBp ?? DEFAULT_SETTINGS.maxSlippageBp),
    enabled: !!s.enabled,
    target: s.target || DEFAULT_SETTINGS.target,
  };
}

export async function setRewardSettings(patch) {
  const next = { ...(await rewardSettings()), ...(patch || {}) };
  await stSet('local', SETTINGS_KEY, next);
  return next;
}

export async function conversions() {
  const l = await stGet('local', LEDGER_KEY, []);
  return Array.isArray(l) ? l : [];
}

/** Outpoints already committed to a conversion, pending or done.
 *
 *  Both states hold their coins. Only a DEFINITE refusal releases them: an
 *  executor that threw may have paid before it threw, and releasing there is
 *  how a wallet sells the same reward twice. */
export async function convertedOutpoints() {
  const out = [];
  for (const c of await conversions()) {
    if (c.state === 'pending' || c.state === 'done') out.push(...(c.inputs || []));
  }
  return out;
}

async function recordConversion(rec) {
  const l = await conversions();
  l.unshift(rec);
  await stSet('local', LEDGER_KEY, l.slice(0, 200));
  return rec;
}

async function settleConversion(id, patch) {
  const l = await conversions();
  const i = l.findIndex((c) => c.id === id);
  if (i < 0) return;
  l[i] = { ...l[i], ...patch };
  await stSet('local', LEDGER_KEY, l);
}

/** The settings as SWK's `SettingsDto`: native BTC is `target: null` there. */
function forEngine(s) {
  return JSON.stringify({
    enabled: !!s.enabled,
    target: s.target === NATIVE_BTC ? null : s.target,
    exclude: s.exclude || [],
    minReceive: Number(s.minReceive),
    maxSlippageBp: Number(s.maxSlippageBp),
  });
}

/**
 * One pass of the engine.
 *
 * ctx:
 *   engine       the SWK wasm bindings (attributeStakingRewards,
 *                planRewardBatches, decideRewardConversion)
 *   walletTxs()  -> the facts attribution needs
 *   stakingKeys()
 *   tipHeight()
 *   quoteFor({asset, atoms, target}) -> {receives, reference} | null
 *   execute(plan) -> {ok, txid?, received?, error?}
 *
 * With `dryRun` nothing is spent and nothing is recorded: the answer is what
 * the wallet WOULD do, which is what the popup shows.
 */
export async function runAutoConvert(ctx, { dryRun = false } = {}) {
  const settings = await rewardSettings();
  const report = { ran: false, settings, considered: [], converted: [], errors: [] };
  if (!settings.enabled && !dryRun) return report;

  const rewards = ctx.engine.attributeStakingRewards(
    JSON.stringify(ctx.walletTxs() || []),
    JSON.stringify(ctx.stakingKeys() || []),
    Number(ctx.tipHeight() || 0),
    100,                       // COINBASE_MATURITY
  ) || [];

  const batches = ctx.engine.planRewardBatches(
    JSON.stringify(rewards),
    forEngine(settings),
    JSON.stringify(await convertedOutpoints()),
  ) || [];
  report.ran = true;

  for (const batch of batches) {
    let quote = null;
    try {
      quote = await ctx.quoteFor({ asset: batch.asset, atoms: batch.value, target: settings.target });
    } catch (e) {
      // A book we could not READ is not a book that said no.
      quote = null;
      report.errors.push({ asset: batch.asset, error: String((e && e.message) || e) });
    }

    const decision = ctx.engine.decideRewardConversion(
      JSON.stringify(batch),
      JSON.stringify(quote),
      forEngine(settings),
    );
    const row = { batch, quote, decision };
    report.considered.push(row);
    if (!decision || !decision.converts || dryRun) continue;

    const rec = await recordConversion({
      id: `${batch.asset}:${(batch.inputs || []).slice().sort().join(',')}`,
      state: 'pending',
      at: Date.now(),
      asset: batch.asset,
      value: String(batch.value),
      target: settings.target,
      expected: String(decision.receives),
      inputs: (batch.inputs || []).slice(),
    });

    try {
      const res = await ctx.execute({
        asset: batch.asset,
        atoms: batch.value,
        inputs: (batch.inputs || []).slice(),
        target: settings.target,
        expected: decision.receives,
        maxSlippageBp: settings.maxSlippageBp,
      });
      if (res && res.ok) {
        await settleConversion(rec.id, { state: 'done', txid: res.txid || null });
        report.converted.push({ ...row, txid: res.txid || null });
      } else {
        // A definite refusal: the sale did not happen, so release the coins.
        const err = String((res && res.error) || 'conversion did not complete');
        await settleConversion(rec.id, { state: 'failed', error: err });
        report.errors.push({ asset: batch.asset, error: err });
      }
    } catch (e) {
      // NOT a definite refusal. The record stays pending, so those coins are
      // never offered again and a human sees it stuck rather than the wallet
      // quietly double-selling.
      const err = String((e && e.message) || e);
      await settleConversion(rec.id, { error: err });
      report.errors.push({ asset: batch.asset, error: err });
    }
  }

  return report;
}

/** Per asset: what is spendable now, what is still maturing, and from where. */
export function totalsOf(rewards) {
  const by = new Map();
  for (const r of rewards || []) {
    let t = by.get(r.asset);
    if (!t) { t = { asset: r.asset, mature: 0n, immature: 0n, outputs: 0, sources: {} }; by.set(r.asset, t); }
    t.outputs++;
    t.sources[r.source] = (t.sources[r.source] || 0) + 1;
    if (r.spent) continue;
    const v = BigInt(r.value);
    if (r.mature) t.mature += v; else t.immature += v;
  }
  return [...by.values()];
}

/**
 * How much of a batch a WHOLE-HTLC offer may take.
 *
 * The cross-chain rail rests whole offers and the one picked is the smallest
 * that COVERS the request, which can be far larger than the batch. Taking it
 * whole would sell coins staking never paid. Selling LESS is normal: the
 * remainder waits.
 */
export function sliceForWholeHtlc(offerAtoms, batchAtoms) {
  const offer = BigInt(offerAtoms || 0n);
  const batch = BigInt(batchAtoms || 0n);
  if (offer <= 0n || batch <= 0n) return 0n;
  return offer < batch ? offer : batch;
}
