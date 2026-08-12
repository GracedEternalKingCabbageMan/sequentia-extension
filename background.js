// Background service worker: owns the wallet engine and routes every message.
//
// Three kinds of clients talk to it:
//  - the popup + approval pages (scope 'ui'), which also hold a long-lived
//    Port while open so the worker (and the wasm engine) stays warm;
//  - content scripts relaying website provider requests (scope 'dapp');
//  - chrome.alarms (auto-lock).
//
// All amounts cross this boundary as strings (BigInt does not survive
// extension messaging).

import './src/shim.js';
import * as engine from './src/engine.js';
import * as A from './src/assets.js';
import * as openamp from './src/openamp.js';
import * as ln from './src/ln.js';
import * as dex from './src/dex.js';
import * as perms from './src/permissions.js';
import * as router from './src/provider-router.js';
import {
  vaultExists, vaultCreate, vaultUnlock, vaultLock, sessionMnemonic,
  armAutoLock, touchAutoLock,
} from './src/vault.js';
import { stGet, stSet, parseAtoms } from './src/util.js';
import { EXPLORER_TX, EXPLORER_T4_TX } from './src/config.js';

// ---- dapp event ports (content scripts subscribe after connect) ----
const dappPorts = new Map();   // origin -> Set<Port>
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'seq-dapp') {
    let origin = '';
    try { origin = new URL(port.sender.url).origin; } catch {}
    if (!origin) return;
    if (!dappPorts.has(origin)) dappPorts.set(origin, new Set());
    dappPorts.get(origin).add(port);
    port.onDisconnect.addListener(() => {
      const s = dappPorts.get(origin);
      if (s) { s.delete(port); if (!s.size) dappPorts.delete(origin); }
    });
  }
  // 'seq-ui' ports exist purely to keep the service worker alive while the
  // popup is open; no messages flow over them.
});

function emitToOrigin(origin, event, data) {
  const s = dappPorts.get(origin);
  if (!s) return;
  for (const p of s) { try { p.postMessage({ event, data }); } catch {} }
}
function emitToAll(event, data) {
  for (const origin of dappPorts.keys()) emitToOrigin(origin, event, data);
}

// ---- LN + DEX progress relayed to whichever UI page is listening ----
ln.setProgressSink((text) => {
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'ln-progress', text }).catch(() => {});
});
dex.setProgressSink((text) => {
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'ln-progress', text }).catch(() => {});
  emitToAll('dexProgress', { text });
});

// ---- unlock lifecycle ----
async function afterUnlock() {
  await engine.ensureOpen();
  await armAutoLock();
  // Non-blocking warm-up: registry, prices, fee rates, OpenAMP identity,
  // pending Lightning move resume, first sync.
  (async () => {
    await Promise.allSettled([A.loadRegistry(), A.loadPrices(), A.fetchFeeRates()]);
    await Promise.allSettled([openamp.oampInit()]);
    await Promise.allSettled([openamp.refreshBalances(), engine.sync()]);
    ln.resumePendingMove().catch(() => {});
  })().catch(() => {});
}

async function doLock() {
  await vaultLock();
  engine.closeWallet();
  emitToAll('accountsChanged', { accounts: [] });
  chrome.runtime.sendMessage({ scope: 'ui-event', event: 'locked' }).catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autolock') doLock().catch(() => {});
});

// Rebuild engine state silently if the worker restarted while unlocked — but
// do NOT rerun the heavy warm-up (full scan + cache-base scan): the worker
// cold-starts constantly, and a scan's synchronous wasm stretches starve the
// event loop enough to stall a concurrent Noise handshake past the hosted
// node's act-three deadline (seen live: the LN device signer could never
// attach right after a cold start). Requests pull their own freshness via
// syncIfStale; only a pending Lightning move (fund safety) resumes eagerly.
(async () => {
  if (await sessionMnemonic()) {
    await engine.ensureOpen().catch(() => {});
    if (await ln.pendingMove()) ln.resumePendingMove().catch(() => {});
  }
})();

// ---- overview composition for the popup ----
async function overview({ withLn = false } = {}) {
  await engine.ensureOpen();
  // Keep display data fresh without the unlock-time warm-up: refresh prices,
  // fee rates, and the registry in the background when they have gone stale.
  if (A.pricesStale()) {
    A.loadPrices().catch(() => {});
    A.fetchFeeRates().catch(() => {});
    A.loadRegistry().catch(() => {});
  }
  const settings = (await stGet('local', 'ext.settings')) || {};
  const ref = settings.refCcy || 'USD';
  const bal = await engine.balances();
  const heldSeq = Object.keys(bal.seq).filter((h) => BigInt(bal.seq[h] || 0) > 0n);
  let lnSum = { deployed: false, perKind: {} };
  if (withLn) { try { lnSum = await ln.summary(Object.keys(bal.seq)); } catch {} }

  const rows = [];
  const push = (key, onchainAtoms, alwaysShow) => {
    const lnEntry = lnSum.perKind[key];
    const lnAtoms = lnEntry ? BigInt(lnEntry.units) : 0n;
    const total = BigInt(onchainAtoms) + lnAtoms;
    if (!alwaysShow && total <= 0n) return;
    const m = A.assetMeta(key);
    rows.push({
      key,
      ticker: m.ticker, name: m.name, precision: m.precision,
      onchain: String(onchainAtoms), ln: lnAtoms.toString(), lnChannels: lnEntry ? lnEntry.channels : 0,
      total: total.toString(),
      refStr: A.refValueStr(key, total, ref),
      refVal: (() => { const rv = A.refValue(key, total, ref); return rv ? rv.v : null; })(),
      verified: A.assetVerified(key), registered: A.assetRegistered(key), domain: A.assetDomain(key),
      restricted: key.startsWith('oamp:'),
      legend: key.startsWith('oamp:') ? openamp.composeLegend(key.slice(5)) : null,
      feePriced: (() => { try { return key !== 'BTC' && !key.startsWith('oamp:') && !!A.feeRateEntry(key); } catch { return false; } })(),
    });
  };

  // Dual-chain + equal standing: BTC (parent chain) always shows, even at 0;
  // every other asset only when its total is non-zero; nothing is pinned or
  // privileged beyond that. Headline = portfolio total in the reference currency.
  push('BTC', bal.btc, true);
  for (const h of Object.keys(bal.seq)) push(h, bal.seq[h], false);
  for (const [id, atoms] of Object.entries(openamp.balancesMap())) push('oamp:' + id, atoms, false);
  rows.sort((a, b) => (a.key === 'BTC' ? -1 : b.key === 'BTC' ? 1 : (b.refVal || 0) - (a.refVal || 0)));

  let totalRef = 0, anyPriced = false;
  for (const r of rows) if (r.refVal != null) { totalRef += r.refVal; anyPriced = true; }

  return {
    rows,
    ref, refOptions: A.refOptions(),
    totalRefStr: anyPriced ? A.fmtRef(totalRef, ref) : null,
    pricesStale: A.pricesStale(),
    scanned: bal.scanned,
    lnDeployed: lnSum.deployed,
    heldSeq,
    lnCapable: ln.capableKinds(heldSeq),
    oampAid: openamp.aid() || null,
    oampAssets: Object.values(openamp.assets()).map((a) => ({ id: a.id, ticker: a.ticker, name: a.name, precision: a.precision })),
    pendingMove: await ln.pendingMove(),
    policyHex: engine.getPolicyHex(),
    explorerTx: EXPLORER_TX, explorerT4Tx: EXPLORER_T4_TX,
  };
}

// ---- send routing (popup review flow) ----
async function prepareSend({ rows, feeAsset, feeRate }) {
  await engine.ensureOpen();
  if (!rows || !rows.length) throw new Error('add a recipient');
  const kinds = new Set(rows.map((r) => (r.asset === 'BTC' ? 'btc' : r.asset.startsWith('oamp:') ? 'oamp' : 'seq')));
  if (kinds.size > 1) throw new Error('BTC, Sequentia, and restricted-asset sends cannot be mixed in one transaction');
  const kind = [...kinds][0];
  if (kind === 'btc') {
    if (rows.length !== 1) throw new Error('one recipient per Bitcoin transaction');
    const r = await engine.prepareBtcSend(rows[0].addr, rows[0].amtS, feeRate);
    return { ...r, kind: 'btc' };
  }
  if (kind === 'oamp') {
    if (rows.length !== 1) throw new Error('one recipient per restricted-asset transfer');
    const row = rows[0];
    const meta = A.assetMeta(row.asset);
    const atoms = parseAtoms(row.amtS, meta.precision);
    const r = await openamp.prepareTransfer(row.asset.slice(5), row.addr.trim(), atoms.toString());
    return { ...r, kind: 'oamp' };
  }
  const r = await engine.prepareSeqSend(rows, feeAsset, feeRate);
  return { ...r, kind: 'seq' };
}

async function confirmSend({ id, kind }) {
  if (kind === 'oamp') return await openamp.completeTransfer(id);
  return await engine.confirmSend(id);
}

// ---- the UI method table ----
const uiMethods = {
  'state': async () => ({
    hasVault: await vaultExists(),
    unlocked: !!(await sessionMnemonic()),
    network: 'sequentia-testnet',
    pendingApproval: router.anyPendingApproval(),
  }),
  'generateMnemonic': async () => ({ mnemonic: await engine.randomMnemonic(12) }),
  'create': async ({ mnemonic, password }) => {
    await engine.validateMnemonic(mnemonic);
    await vaultCreate(mnemonic, password);
    await engine.openFromPhrase(mnemonic);
    await afterUnlock();
    return { ok: true };
  },
  'unlock': async ({ password }) => {
    const phrase = await vaultUnlock(password);
    await engine.openFromPhrase(phrase);
    await afterUnlock();
    return { ok: true };
  },
  'lock': async () => { await doLock(); return { ok: true }; },
  'revealMnemonic': async ({ password }) => ({ mnemonic: await vaultUnlock(password) }),
  'sync': async () => { await engine.ensureOpen(); await engine.sync(); await openamp.refreshBalances().catch(() => {}); return { ok: true }; },
  'overview': async (p) => overview(p || {}),
  'receive': async ({ confidential, fresh }) => {
    await engine.ensureOpen();
    const a = fresh ? engine.newAddress(!!confidential) : engine.currentAddress(!!confidential);
    return { ...a, qr: engine.qrFor(a.address) };
  },
  'oampReceive': async ({ assetId }) => {
    const address = await openamp.depositAddress(assetId);
    return { aid: openamp.aid(), address, qr: address ? engine.qrFor(address) : null, aidQr: engine.qrFor(openamp.aid()) };
  },
  'prepareSend': prepareSend,
  'confirmSend': confirmSend,
  'dropSend': async ({ id, kind }) => { kind === 'oamp' ? openamp.dropTransfer(id) : engine.dropPrepared(id); return { ok: true }; },
  'history': async () => {
    await engine.ensureOpen();
    const [seq, btc, oamp] = await Promise.all([
      Promise.resolve(engine.seqHistory()),
      engine.btcHistory().catch(() => []),
      openamp.transferHistory(),
    ]);
    // Attach display meta so the popup needs no asset table of its own.
    const withMeta = (list) => list.map((t) => ({
      ...t,
      display: Object.entries(t.deltas).map(([h, v]) => ({ ticker: A.assetMeta(h).ticker, precision: A.assetMeta(h).precision || (h === 'BTC' ? 8 : 0), atoms: v })),
    }));
    return { seq: withMeta(seq), btc: withMeta(btc), oamp };
  },
  'feeAssets': async () => {
    await engine.ensureOpen();
    const bal = await engine.balances();
    const held = Object.keys(bal.seq).filter((h) => BigInt(bal.seq[h] || 0) > 0n);
    const priced = A.feePricedAssets(held);
    const policy = engine.getPolicyHex();
    if (!priced.includes(policy) && (() => { try { A.feeRateFor(policy); return true; } catch { return false; } })()) priced.unshift(policy);
    return { assets: priced.map((h) => ({ hex: h, ticker: A.assetMeta(h).ticker })) };
  },
  'lnInvoice': async ({ kind, amount, memo }) => await ln.createInvoice({ kind, atoms: amount, memo }),
  'lnPay': async ({ kind, bolt11 }) => await ln.payInvoice({ kind, bolt11 }),
  'lnMove': async ({ kind, amount }) => await ln.moveToLightning({ kind, atoms: amount }),
  'lnClose': async ({ kind }) => await ln.closeToChain({ kind }),
  'getSettings': async () => ((await stGet('local', 'ext.settings')) || {}),
  'setSettings': async (p) => {
    const s = (await stGet('local', 'ext.settings')) || {};
    Object.assign(s, p || {});
    await stSet('local', 'ext.settings', s);
    return s;
  },
  'sites': async () => ({ sites: await perms.sites() }),
  'revokeSite': async ({ origin }) => {
    await perms.revoke(origin);
    emitToOrigin(origin, 'disconnect', {});
    return { ok: true };
  },
  'approval.get': async ({ id }) => {
    const p = id ? router.pendingApproval(id) : router.anyPendingApproval();
    return { approval: p, unlocked: !!(await sessionMnemonic()) };
  },
  'approval.unlock': async ({ password }) => {
    const phrase = await vaultUnlock(password);
    await engine.openFromPhrase(phrase);
    await afterUnlock();
    return { ok: true };
  },
  'approval.decide': async ({ id, approve }) => await router.decideApproval(id, !!approve),
};

// ---- message dispatch ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.scope === 'ui') {
        // Only extension pages may use the ui scope.
        if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith('chrome-extension://'))) {
          throw new Error('forbidden');
        }
        const fn = uiMethods[msg.method];
        if (!fn) throw new Error('unknown ui method: ' + msg.method);
        await touchAutoLock();
        const result = await fn(msg.params || {});
        sendResponse({ ok: true, result });
        return;
      }
      if (msg && msg.scope === 'dapp') {
        let origin = '';
        try { origin = new URL(sender.url).origin; } catch {}
        const result = await router.handleDappRequest(origin, msg.method, msg.params || {});
        sendResponse({ ok: true, result });
        return;
      }
      sendResponse({ ok: false, error: 'unknown scope' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) ?? e) });
    }
  })();
  return true;   // async response
});
