// SEQUENTIA staking pools, from the extension.
//
// What this offers is DELEGATION only: lend the stake weight this wallet's
// staking key already carries to a pool, move it between pools, and take it
// back. It does not offer staking itself, and it does not offer running a pool.
//
// The line is not arbitrary. Registering a stake locks coins for an unbonding
// period, and announcing a payout policy binds every block a key ever produces
// and needs that key online on the machine producing them; neither belongs to a
// browser popup that is closed most of the time. Delegating asks nothing of the
// device afterwards: the record sits on-chain lending weight whether or not this
// extension is ever opened again.
//
// The safety properties that make that reasonable, all enforced by the chain:
//   * the pool's key appears nowhere in the staking output's spending
//     condition, so a pool can never spend a delegator's coins;
//   * delegating moves no coins at all, and neither does leaving;
//   * only this wallet's staking key can spend the delegation record, so
//     leaving needs nobody's cooperation and has no notice period.
//
// Because of that last one, "leave" must always work. This module therefore
// never gates leaving on the pool board being reachable, and reports its own
// unavailability rather than silently disabling the button.

import * as lwk from '../pkg/lwk_wasm.js';
import { BASE, ESPLORA } from './config.js';
import { getSigner, getWollet, getMnemonic, getNetwork, withWollet } from './engine.js';
// Kept in its own module, free of the wasm engine, so the copy that IS the
// delegator's protection can be unit-tested.
export { delegationWarnings as warnings } from './staking-warnings.js';

export const POOLS_URL = BASE + '/pools/pools.json';

/// The record's own value: enough to clear the relay floor and to pay the fee
/// each time it is spent, with room for several moves between pools. All of it
/// comes back when the delegation is reclaimed.
const RECORD_ATOMS = 100000n;   // 0.001 tSEQ

/// The spend's shape is fixed: one bare input, one output, one fee output, about
/// 230 vB. Priced at the same rate the rest of the wallet uses.
const SPEND_VBYTES = 230n;
const FEE_RATE_SAT_KVB = 2000n;
const spendFee = () => (SPEND_VBYTES * FEE_RATE_SAT_KVB + 999n) / 1000n;

/// Whether the vendored wasm build is new enough to SPEND a record. Shipping
/// "join a pool" without "leave a pool" would be a one-way door, so the whole
/// feature reports itself unavailable rather than offering half of it.
export function supported() {
  return typeof lwk.findDelegationRecords === 'function'
      && typeof lwk.buildDelegationSpendTx === 'function';
}

/// The public pool board's feed. Read-only and advisory: everything here is
/// about CHOOSING a pool, never about leaving one.
export async function fetchPools() {
  const r = await fetch(POOLS_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error('pool board returned ' + r.status);
  const j = await r.json();
  if (!j || !Array.isArray(j.pools)) throw new Error('unexpected pool board response');
  return j;
}

/// This wallet's live delegation record, or null.
///
/// The record is a bare script, so the wallet does not hold it as one of its own
/// coins and a restored seed has no local note of it. But the transaction that
/// FUNDED it spent this wallet's coins and is therefore in its history: scan
/// those outputs for a record naming this wallet's staking key, then ask the
/// explorer whether it is still unspent. That last question is the one the
/// wallet cannot answer itself, because a transaction spending a bare script
/// need not touch this wallet at all and may never be downloaded.
export async function findDelegation() {
  if (!supported()) return null;
  const controller = getSigner().stakerPublicKey();
  const wollet = getWollet();
  const candidates = [];
  for (const wtx of wollet.transactions()) {
    let hex;
    try { hex = wtx.tx().toString(); } catch { continue; }
    let found;
    try { found = lwk.findDelegationRecords(hex, controller); } catch { continue; }
    for (const f of found || []) {
      candidates.push({
        txid: wtx.txid().toString(), vout: f.vout, signer: f.signer,
        atoms: BigInt(f.value), height: wtx.height(),
      });
    }
  }
  if (!candidates.length) return null;
  // Unconfirmed first (it is the most recent thing that happened), then by
  // height descending: a move spends the old record and creates a new one, so
  // the most recent unspent record is the one in force.
  candidates.sort((a, b) => {
    const au = a.height == null, bu = b.height == null;
    if (au !== bu) return au ? -1 : 1;
    if (au) return 0;
    return b.height - a.height;
  });
  for (const c of candidates) {
    try {
      const r = await fetch(`${ESPLORA}/tx/${c.txid}/outspend/${c.vout}`);
      if (!r.ok) continue;
      if ((await r.json())?.spent) continue;    // superseded, or already reclaimed
      const st = await fetch(`${ESPLORA}/tx/${c.txid}/status`);
      c.confirmed = st.ok ? !!(await st.json()).confirmed : false;
      return c;
    } catch { /* transient: try the next candidate */ }
  }
  return null;
}

/// The chain tip, for the spend's nLockTime (anti fee-sniping). A height in the
/// future would make the transaction unminable, so any doubt falls back to 0,
/// which is always valid.
async function tipHeight() {
  try {
    const r = await fetch(`${ESPLORA}/blocks/tip/height`);
    if (r.ok) {
      const h = parseInt((await r.text()).trim(), 10);
      if (Number.isFinite(h) && h >= 0) return h;
    }
  } catch {}
  return 0;
}

function requireSupport() {
  if (!supported()) {
    throw new Error('this build cannot spend a delegation record, so it will not create one either; update the extension');
  }
}

/// Join a pool: fund a delegation record. Returns the unsigned PSET for the
/// normal review-and-sign path.
export async function buildDelegate(signerPubkey) {
  requireSupport();
  const controller = getSigner().stakerPublicKey();
  const target = String(signerPubkey || '').trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(target)) throw new Error('a pool signer key is 66 hex characters');
  if (target === controller) {
    throw new Error('that is this wallet\'s own staking key; delegating to yourself is what already happens with no pool at all');
  }
  return withWollet(async () => {
    const pset = getNetwork().txBuilder()
      .addDelegationOutput(controller, target, RECORD_ATOMS)
      .feeRate(Number(FEE_RATE_SAT_KVB))
      .finish(getWollet());
    return pset.toString();
  });
}

/// Move to another pool, or leave. `rotateTo` null means leave.
///
/// Moving spends the old record and creates the new one in ONE transaction:
/// consensus permits at most one live record per staking key, so leaving and
/// re-joining as two loose transactions could be mined in the order that leaves
/// two live records, which invalidates the block carrying the second.
export async function buildSpend(record, rotateTo) {
  requireSupport();
  if (!record) throw new Error('this wallet is not delegating');
  if (!record.confirmed) throw new Error('the last delegation change has not confirmed yet; wait for it');
  const target = rotateTo ? String(rotateTo).trim().toLowerCase() : null;
  if (target) {
    if (!/^0[23][0-9a-f]{64}$/.test(target)) throw new Error('a pool signer key is 66 hex characters');
    if (target === record.signer) throw new Error('you are already delegating to that pool');
  }
  // Leaving needs somewhere to put the record's coins: a fresh address of this
  // wallet, unblinded, because the record spend creates an explicit output.
  const reclaim = target ? undefined
    : getWollet().address(undefined).address().toUnconfidential().toString();
  const built = lwk.buildDelegationSpendTx({
    mnemonic: getMnemonic(),
    recordTxid: record.txid,
    recordVout: record.vout,
    recordValue: record.atoms.toString(),
    currentSigner: record.signer,
    rotateTo: target || undefined,
    reclaimAddress: reclaim,
    feeAtoms: spendFee().toString(),
    locktime: await tipHeight(),
  }, getNetwork());
  return built;   // { rawHex, txid, outValue, repointed }
}
