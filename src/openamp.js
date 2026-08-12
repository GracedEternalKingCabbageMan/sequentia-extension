// OpenAMP restricted-asset client (enclave-custodied ledger for permissioned
// assets). Ported from the web wallet with the same non-negotiable safety
// mechanism: the wallet NEVER blind-signs — every transfer sighash is
// recomputed locally (enclaveSighash) from explorer-resolved prevouts and the
// transfer is aborted on any mismatch. Signing is deterministic BIP340 at
// m/5/0 inside Rust (openampSignSighash); no key material touches JS.
//
// Restricted balances are equal-standing rows in the same UI as every other
// asset — no privileged label (first principle 3). Route values are prefixed
// "oamp:<assetId>" to distinguish enclave transfers from on-chain sends.

import { openampComputeAid, enclaveSighash, decodeEnclaveSpend } from '../pkg/lwk_wasm.js';
import { OPENAMP, ESPLORA } from './config.js';
import * as A from './assets.js';
import { getSigner, getNetwork } from './engine.js';
import { stGet, stSet } from './util.js';

let OAMP_AID = '';
let OAMP_XONLY = '';
let oampAssets = {};        // assetId -> record
let oampBalances = {};      // assetId -> atoms (string)
let oampLegacyBalances = {};
let oampUser = null;
let OAMP_LEGACY_AID = '';

A.registerOampAssets(() => oampAssets);

export function isOampAsset(v) { return typeof v === 'string' && v.startsWith('oamp:'); }
export function oampId(v) { return v.slice(5); }
export function aid() { return OAMP_AID; }
export function assets() { return oampAssets; }
export function balancesMap() { return oampBalances; }
export function legacyBalancesMap() { return oampLegacyBalances; }
export function userRecord() { return oampUser; }

async function oampFetch(path, opts) {
  const r = await fetch(OPENAMP + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.message || ('OpenAMP HTTP ' + r.status));
  return j;
}

// Derive the m/5/0 identity, compute the AID LOCALLY, register (idempotent),
// assert the server agrees. Non-fatal: an unreachable enclave never blocks the
// rest of the wallet.
export async function oampInit() {
  const signer = getSigner();
  if (!signer) { OAMP_AID = ''; return false; }
  try {
    OAMP_XONLY = signer.openampXonlyPubkey();
    if (OAMP_XONLY.length !== 64) throw new Error('bad m/5/0 enclave key');
    const localAid = openampComputeAid([OAMP_XONLY]);
    const j = await oampFetch('/v1/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkeys: [OAMP_XONLY] }),
    });
    if ((j.aid || '') !== localAid) throw new Error('AID mismatch (server vs local); refusing');
    OAMP_AID = localAid;
    try {
      const kp = signer.htlcKeypair();
      const legacyXonly = (kp.public_key || '').slice(2);
      OAMP_LEGACY_AID = legacyXonly.length === 64 ? openampComputeAid([legacyXonly]) : '';
    } catch { OAMP_LEGACY_AID = ''; }
    await loadAssets();
    await refreshUser();
    return true;
  } catch (e) {
    console.warn('[openamp] init skipped:', e?.message ?? e);
    OAMP_AID = '';
    return false;
  }
}

export async function loadAssets() {
  try {
    const j = await oampFetch('/v1/assets');
    oampAssets = {};
    for (const a of (j.assets || [])) if (a && a.id) oampAssets[a.id] = a;
  } catch {}
}

export async function refreshUser() {
  if (!OAMP_AID) { oampUser = null; return; }
  try {
    const j = await oampFetch('/v1/users/' + encodeURIComponent(OAMP_AID));
    oampUser = { categories: Array.isArray(j.categories) ? j.categories : [], frozen: !!j.frozen };
  } catch {}
}

export async function refreshBalances() {
  if (!OAMP_AID) { oampBalances = {}; oampLegacyBalances = {}; return; }
  const next = {};
  await Promise.all(Object.keys(oampAssets).map(async (id) => {
    try {
      const j = await oampFetch('/v1/users/' + encodeURIComponent(OAMP_AID) + '/balance?asset=' + encodeURIComponent(id));
      next[id] = String(BigInt(j.atoms || 0));
    } catch {}
  }));
  oampBalances = next;
  const legacy = {};
  if (OAMP_LEGACY_AID && OAMP_LEGACY_AID !== OAMP_AID) {
    await Promise.all(Object.keys(oampAssets).map(async (id) => {
      try {
        const j = await oampFetch('/v1/users/' + encodeURIComponent(OAMP_LEGACY_AID) + '/balance?asset=' + encodeURIComponent(id));
        const a = BigInt(j.atoms || 0);
        if (a > 0n) legacy[id] = String(a);
      } catch {}
    }));
  }
  oampLegacyBalances = legacy;
}

export async function depositAddress(assetId) {
  const j = await oampFetch('/v1/users/' + encodeURIComponent(OAMP_AID) + '/address?asset=' + encodeURIComponent(assetId));
  return j.address || '';
}

// Plain-language restriction legend for a restricted asset's row (disclosure,
// not privilege).
export function composeLegend(assetId) {
  const a = oampAssets[assetId] || {};
  const parts = ['Restricted asset: every transfer needs the policy server co-signature.'];
  const r = a.rules || {};
  if (a.clawback) parts.push('Issuer clawback is disclosed and in force.');
  if (Array.isArray(r.allowed_categories) && r.allowed_categories.length) parts.push('Only eligible, categorised holders may receive it.');
  if (r.lockin_until_height > 0) parts.push('Locked until Sequentia block ' + r.lockin_until_height + '.');
  return parts.join(' ');
}

// Resolve each input's prevout from the explorer (the taproot SIGHASH_DEFAULT
// commits to every prevout, so all are needed to recompute a sighash locally).
async function resolvePrevouts(inputs) {
  const prevouts = new Array(inputs.length);
  await Promise.all(inputs.map(async (inp) => {
    const r = await fetch(ESPLORA + '/tx/' + encodeURIComponent(inp.txid));
    if (!r.ok) throw new Error('explorer lookup failed for input ' + inp.index);
    const j = await r.json();
    const o = (j.vout || [])[inp.vout];
    if (!o) throw new Error('prevout ' + inp.txid + ':' + inp.vout + ' not found');
    if (o.value == null || !o.asset) throw new Error('input ' + inp.index + ' spends a confidential/unresolved prevout; cannot verify the sighash');
    prevouts[inp.index] = { asset: o.asset, value: BigInt(o.value), script: o.scriptpubkey };
  }));
  return prevouts;
}

// Two-phase transfer. prepare: draft at the enclave, recompute + verify every
// sighash locally, decode the real effects for the review. complete: sign the
// LOCALLY RECOMPUTED digests and submit.
const drafts = new Map();
let draftSeq = 0;

export async function prepareTransfer(assetId, recipientAid, atomsStr) {
  if (!OAMP_AID) throw new Error('OpenAMP identity is not registered');
  const atoms = BigInt(atomsStr);
  if (atoms <= 0n) throw new Error('amount must be greater than zero');
  if (atoms > 0x7fffffffffffffffn) throw new Error('amount exceeds the protocol maximum');
  const meta = A.assetMeta('oamp:' + assetId);
  // atoms MUST be a bare JSON number (openampd uint64-decodes and rejects strings).
  const body = '{"asset":' + JSON.stringify(assetId) + ',"sender_aid":' + JSON.stringify(OAMP_AID) +
    ',"recipient_aid":' + JSON.stringify(recipientAid) + ',"atoms":' + atoms.toString() + ',"fee_mode":"convert"}';
  const draft = await oampFetch('/v1/transfers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!draft || !draft.tx || !Array.isArray(draft.to_sign)) throw new Error('malformed transfer draft');
  const probe = decodeEnclaveSpend(draft.tx, [], []);
  const addr = await oampFetch('/v1/users/' + encodeURIComponent(OAMP_AID) + '/address?asset=' + encodeURIComponent(assetId));
  const leaf = addr.transfer_leaf, control = addr.transfer_control, myScript = addr.script_pubkey;
  if (!leaf || !control) throw new Error('enclave address is missing the transfer leaf/control');
  const prevouts = await resolvePrevouts(probe.inputs || []);
  const genesis = getNetwork().genesisBlockHash();
  const localDigests = {};
  for (const s of draft.to_sign) {
    const local = enclaveSighash(draft.tx, s.input, prevouts, leaf, control, genesis);
    if (String(local).toLowerCase() !== String(s.sighash || '').toLowerCase())
      throw new Error('sighash mismatch at input ' + s.input + '; refusing to sign');
    localDigests[s.input] = local;
  }
  const effects = decodeEnclaveSpend(draft.tx, prevouts, [myScript]);

  const id = 'o' + (++draftSeq) + '.' + Date.now();
  drafts.set(id, { draft, localDigests, assetId, recipientAid, atoms: atoms.toString(), at: Date.now() });
  for (const [k, v] of drafts) if (Date.now() - v.at > 600000) drafts.delete(k);

  const review = {
    network: 'OpenAMP restricted asset (enclave ledger)',
    recipientAid,
    atoms: atoms.toString(),
    ticker: meta.ticker,
    precision: meta.precision,
    convertFee: (draft.convert_atoms != null && BigInt(draft.convert_atoms) > 0n) ? String(draft.convert_atoms) : null,
    networkFee: draft.fee_sats != null ? String(draft.fee_sats) : null,
    spending: (effects.my_inputs_spent || []).length,
    outputs: (effects.outputs || []).filter((o) => !o.is_fee).map((o) => ({
      asset: o.asset || null, value: o.value != null ? String(o.value) : null, mine: !!o.mine,
    })),
    anyConfidential: !!effects.any_confidential,
  };
  return { id, review };
}

export async function completeTransfer(id) {
  const e = drafts.get(id);
  if (!e) throw new Error('this review expired; rebuild the transfer');
  drafts.delete(id);
  const signer = getSigner();
  const sigs = {};
  for (const s of e.draft.to_sign) sigs[String(s.input)] = signer.openampSignSighash(e.localDigests[s.input]);
  const done = await oampFetch('/v1/transfers/' + encodeURIComponent(e.draft.id) + '/complete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sigs }),
  });
  const txid = done.txid || '';
  // Local transfer history (openampd has no history endpoint).
  try {
    const meta = A.assetMeta('oamp:' + e.assetId);
    const hist = (await stGet('local', 'ext.oampTransfers')) || [];
    hist.unshift({ asset: e.assetId, ticker: meta.ticker, precision: meta.precision, recipient_aid: e.recipientAid, atoms: e.atoms, txid, time: Date.now() });
    await stSet('local', 'ext.oampTransfers', hist.slice(0, 100));
  } catch {}
  refreshBalances().catch(() => {});
  return { txid };
}
export function dropTransfer(id) { drafts.delete(id); }

export async function transferHistory() {
  return (await stGet('local', 'ext.oampTransfers')) || [];
}
