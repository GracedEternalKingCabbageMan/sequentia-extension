// Offscreen document: the home for LONG Lightning operations. A service
// worker gets killed by idle clocks and task caps no keepalive fully
// defeats; this is a real page with neither. The worker hands a job over,
// this page runs it to completion (however long the hosted nodes take),
// streams progress, and writes the result to storage — so even a worker
// death cannot lose the outcome. The mnemonic arrives over extension
// messaging (trusted contexts only) and never leaves this page.
import {
  initSeqln, provisionAndConnect, waitNodeReady, seqlnChannelInbound, seqlnSwap,
  seqlnNodeInvoice, provisionedState, deviceTransportPubkey,
} from './vendor/seqln.js';
import { lnDeriveNode, lnDeriveAsset } from './vendor/seqln-keys.js';
import { LSP } from './src/config.js';

initSeqln({
  lspUrl: LSP.url,
  token: LSP.token,
  wsBase: LSP.wsBase,
  // A page may dynamic-import, so the default sdkPath works here.
  nodes: {
    asset: { wsUrl: LSP.wsAsset, hostPubkey: LSP.hostPubkeyAsset },
    btc: { wsUrl: LSP.wsBtc, hostPubkey: LSP.hostPubkeyBtc },
  },
});

function progress(job, text) {
  chrome.runtime.sendMessage({ scope: 'oln-progress', job, text }).catch(() => {});
}

// Offscreen documents may use no chrome API beyond runtime messaging —
// chrome.storage does not exist here (a first-line use of it silently killed
// whole runs). Durable writes are relayed to the service worker, and each
// relay message also wakes the worker.
function store(key, val) {
  return chrome.runtime.sendMessage({ scope: 'oln-store', key, val });
}
async function storeSure(key, val) {
  for (let i = 0; i < 10; i++) {
    try { await store(key, val); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
}

// nodeKey -> ms of the last SUCCESSFUL swap step on it. While a node is hot
// (and its signer never dropped — the offscreen document now OUTLIVES jobs, so
// wss signer links persist), the bring-up ritual (provision HTTP, readiness
// poll, inbound ensure, hintability probe) is skipped wholesale: those exist
// for cold/revived nodes, and re-running them cost ~15s of every warm swap.
const HOT = {};
const HOT_TTL = 5 * 60_000;

async function connectOwn(kind, phrase, label) {
  const expect = kind === 'BTC'
    ? 'btc:' + String(await deviceTransportPubkey(lnDeriveNode(phrase, 'btc').transportPrivkey)).toLowerCase()
    : String(kind).toLowerCase();
  const st = provisionedState()[expect];
  if (st && st.connected && st.nodeId) return { connected: true, key: expect, nodeId: st.nodeId, warm: true };
  const prov = kind === 'BTC'
    ? await provisionAndConnect({
        chain: 'btc', label: 'BTC', policy: 'enforce',
        deriveIdentity: () => { const d = lnDeriveNode(phrase, 'btc'); return { transportPrivkey: d.transportPrivkey, signingSeed: d.signingSeed }; },
      })
    : await provisionAndConnect({
        chain: 'seq', assetId: kind, label, policy: 'enforce',
        deriveIdentity: (id) => lnDeriveAsset(phrase, id),
      });
  if (!(prov && prov.connected)) throw new Error('could not bring your device signer online for your ' + label + ' Lightning node');
  return prov;
}

async function waitPatient(job, nodeKey, label, totalMs = 8 * 60_000) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try {
      await waitNodeReady({ nodeKey, onProgress: () => progress(job, 'Preparing your ' + label + ' node (booting and syncing)…') });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      progress(job, 'Your ' + label + ' node is still syncing; holding on…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// The 902 boot race: a just-revived node answers RPC well before its channels
// finish re-establishing with their peers, and creating an invoice with route
// hints then fails ("None of those hints were suitable local channels" — seen
// live killing a swap before any HTLC existed; the channel became hintable 91s
// after boot). Creating a throwaway hold-invoice IS the exact readiness test,
// so keep probing until hints resolve, then let the real swap proceed.
async function waitHintable(job, nodeKey, asset, label, totalMs = 150_000) {
  const deadline = Date.now() + totalMs;
  const rnd = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(rnd);
    const hash = [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await seqlnNodeInvoice({ node_key: nodeKey, asset, amount: 1, payment_hash: hash, expiry: 60 });
      return;
    } catch (e) {
      // Only the hint race is worth waiting out; any other failure belongs to
      // the swap itself, which will surface it honestly.
      if (!/hints|suitable|902/i.test(String((e && e.message) ?? e))) return;
      if (Date.now() > deadline) return;
      progress(job, 'Your ' + label + ' channel is coming online; holding until it can receive…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function runSwap(job, p, marks) {
  const mark = (st) => marks.push([st, Date.now()]);
  mark('start');
  const provBase = await connectOwn(p.base, p.phrase, p.baseTicker);
  mark(provBase.warm ? 'base-warm' : 'base-connected');
  const provCounter = await connectOwn(p.counterKind, p.phrase, p.counterTicker);
  mark(provCounter.warm ? 'counter-warm' : 'counter-connected');
  const hotBase = provBase.warm && (Date.now() - (HOT[provBase.key] || 0) < HOT_TTL);
  const hotCounter = provCounter.warm && (Date.now() - (HOT[provCounter.key] || 0) < HOT_TTL);
  if (!hotBase) {
    progress(job, 'Bringing your ' + p.baseTicker + ' Lightning node online…');
    await waitPatient(job, provBase.key, p.baseTicker);
    mark('base-ready');
  }
  if (!hotCounter) {
    progress(job, 'Bringing your ' + p.counterTicker + ' Lightning node online…');
    await waitPatient(job, provCounter.key, p.counterTicker);
    mark('counter-ready');
  }
  const recvProv = p.side === 'buy' ? provBase : provCounter;
  const recvAsset = p.side === 'buy' ? p.base : (p.counterKind === 'BTC' ? undefined : p.counterKind);
  const recvLabel = p.side === 'buy' ? p.baseTicker : p.counterTicker;
  const hotRecv = (p.side === 'buy' ? hotBase : hotCounter);
  if (!hotRecv) {
    progress(job, 'Ensuring inbound capacity on your receiving leg…');
    try {
      if (p.side === 'buy') await seqlnChannelInbound({ node_key: provBase.key, asset: p.base, amount: Number(p.recvAtoms) });
      else await seqlnChannelInbound({ node_key: provCounter.key, asset: p.counterKind === 'BTC' ? undefined : p.counterKind, amount: Number(p.recvAtoms) });
    } catch {}
    mark('inbound-ensured');
    await waitHintable(job, recvProv.key, recvAsset, recvLabel);
    mark('hintable');
  }
  progress(job, 'Settling over Lightning…');
  const r = await seqlnSwap({
    side: p.side, asset: p.base, amount: p.amountUnits,
    quote_asset: p.counterKind === 'BTC' ? undefined : p.counterKind,
    node_key: provBase.key, counter_node_key: provCounter.key,
    offer_id: p.offerId, maker_pubkey: p.makerPubkey,
    take_atoms: p.takeAtomsNum ?? undefined,
  });
  mark('settled');
  HOT[provBase.key] = HOT[provCounter.key] = Date.now();
  return {
    settled: true,
    direction: r.direction || (p.side === 'sell' ? 'sold' : 'bought'),
    baseAtoms: String(r.base_amount ?? p.takeAtoms),
    quoteAtoms: String(r.quote_amount ?? p.quoteAtoms),
    preimage: r.preimage || null,
    paymentHash: r.hash_h || null,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scope !== 'oln') return;
  // Liveness + build handshake: the dispatcher reuses this document (keeping
  // signer wss links warm across swaps) only when it answers with the current
  // version; a stale or dead doc gets recreated instead.
  if (msg.op === 'hello') { sendResponse({ version: chrome.runtime.getManifest().version }); return false; }
  if (msg.op !== 'swap') return;
  sendResponse({ accepted: true });
  (async () => {
    const key = 'ext.olnjob.' + msg.job;
    // Overwrite the dispatcher's started record with proof this page ran.
    await storeSure(key, { done: false, started: true, offscreen: true, at: Date.now() });
    // Liveness pings: each one wakes the service worker, and a live worker
    // retains this offscreen page (its death took the page — and the job —
    // with it in earlier runs). Also stamps a heartbeat for post-mortems.
    const pinger = setInterval(() => {
      chrome.runtime.sendMessage({ scope: 'oln-ping', job: msg.job }).catch(() => {});
      store('ext.olnhb.' + msg.job, Date.now()).catch(() => {});
    }, 15000);
    const marks = [];
    try {
      const result = await runSwap(msg.job, msg.params, marks);
      await storeSure(key, { done: true, ok: true, result, marks, at: Date.now() });
      progress(msg.job, 'Swap settled.');
    } catch (e) {
      await storeSure(key, { done: true, ok: false, error: String((e && e.message) ?? e), marks, at: Date.now() });
    } finally {
      clearInterval(pinger);
    }
    chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
  })();
  return false;
});
