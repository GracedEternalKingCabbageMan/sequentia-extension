// Offscreen document: the home for LONG Lightning operations. A service
// worker gets killed by idle clocks and task caps no keepalive fully
// defeats; this is a real page with neither. The worker hands a job over,
// this page runs it to completion (however long the hosted nodes take),
// streams progress, and writes the result to storage — so even a worker
// death cannot lose the outcome. The mnemonic arrives over extension
// messaging (trusted contexts only) and never leaves this page.
import {
  initSeqln, provisionAndConnect, waitNodeReady, seqlnChannelInbound, seqlnSwap,
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

async function connectOwn(kind, phrase, label) {
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

async function runSwap(job, p) {
  progress(job, 'Bringing your ' + p.baseTicker + ' Lightning node online…');
  const provBase = await connectOwn(p.base, p.phrase, p.baseTicker);
  await waitPatient(job, provBase.key, p.baseTicker);
  progress(job, 'Bringing your ' + p.counterTicker + ' Lightning node online…');
  const provCounter = await connectOwn(p.counterKind, p.phrase, p.counterTicker);
  await waitPatient(job, provCounter.key, p.counterTicker);
  progress(job, 'Ensuring inbound capacity on your receiving leg…');
  try {
    if (p.side === 'buy') await seqlnChannelInbound({ node_key: provBase.key, asset: p.base, amount: Number(p.recvAtoms) });
    else await seqlnChannelInbound({ node_key: provCounter.key, asset: p.counterKind === 'BTC' ? undefined : p.counterKind, amount: Number(p.recvAtoms) });
  } catch {}
  progress(job, 'Settling over Lightning…');
  const r = await seqlnSwap({
    side: p.side, asset: p.base, amount: p.amountUnits,
    quote_asset: p.counterKind === 'BTC' ? undefined : p.counterKind,
    node_key: provBase.key, counter_node_key: provCounter.key,
    offer_id: p.offerId, maker_pubkey: p.makerPubkey,
    take_atoms: p.takeAtomsNum ?? undefined,
  });
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
  if (!msg || msg.scope !== 'oln' || msg.op !== 'swap') return;
  sendResponse({ accepted: true });
  (async () => {
    const key = 'ext.olnjob.' + msg.job;
    // A started record immediately: a vanished job must never read as "none".
    await chrome.storage.local.set({ [key]: { done: false, started: true, at: Date.now() } });
    // Liveness pings: each one wakes the service worker, and a live worker
    // retains this offscreen page (its death took the page — and the job —
    // with it in earlier runs). Also stamps a heartbeat for post-mortems.
    const pinger = setInterval(() => {
      chrome.runtime.sendMessage({ scope: 'oln-ping', job: msg.job }).catch(() => {});
      chrome.storage.local.set({ ['ext.olnhb.' + msg.job]: Date.now() }).catch(() => {});
    }, 15000);
    try {
      const result = await runSwap(msg.job, msg.params);
      await chrome.storage.local.set({ [key]: { done: true, ok: true, result, at: Date.now() } });
      progress(msg.job, 'Swap settled.');
    } catch (e) {
      await chrome.storage.local.set({ [key]: { done: true, ok: false, error: String((e && e.message) ?? e), at: Date.now() } });
    } finally {
      clearInterval(pinger);
    }
    chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
  })();
  return false;
});
