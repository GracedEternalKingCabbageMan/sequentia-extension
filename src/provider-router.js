// Website provider request router.
//
// Handles window.sequentia requests relayed by the content script. The
// protocol is documented in doc/PROVIDER.md — keep the two in sync. Sensitive
// methods run through an approval window (one per request); `connect` is
// approved once per origin and persists until revoked in Settings.

import * as engine from './engine.js';
import * as perms from './permissions.js';
import * as openamp from './openamp.js';
import * as ln from './ln.js';
import * as A from './assets.js';
import { sessionMnemonic } from './vault.js';

// ---- pending approvals ----
const pending = new Map();
let reqSeq = 0;

function newRequestId() { return 'req' + (++reqSeq) + '.' + Date.now(); }

export function pendingApproval(id) {
  const p = pending.get(id);
  if (!p) return null;
  return { id, origin: p.origin, method: p.method, display: p.display };
}
export function anyPendingApproval() {
  const first = pending.keys().next();
  return first.done ? null : pendingApproval(first.value);
}

// Approvals open as a regular TAB, not a floating popup window: on tiling /
// Wayland window managers (seen live on COSMIC) a popup created by a freshly
// reloaded service worker can land invisible, and an approval the user cannot
// see times out. A tab is always reachable from the tab strip.
async function openApprovalWindow(id) {
  await chrome.tabs.create({
    url: chrome.runtime.getURL('approval/approval.html') + '?id=' + encodeURIComponent(id),
    active: true,
  });
}

// Ask the user. `display` is the serializable summary the approval page renders.
function requestApproval(origin, method, display, exec) {
  return new Promise((resolve, reject) => {
    const id = newRequestId();
    pending.set(id, { origin, method, display, exec, resolve, reject, at: Date.now() });
    // Expire abandoned approvals after 5 minutes.
    setTimeout(() => {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.reject(new Error('approval timed out')); }
    }, 300000);
    openApprovalWindow(id).catch((e) => {
      pending.delete(id);
      reject(new Error('could not open the approval window: ' + (e?.message ?? e)));
    });
  });
}

// The approval page decided. Executes the underlying operation on approve.
export async function decideApproval(id, approve) {
  const p = pending.get(id);
  if (!p) throw new Error('this request has expired');
  pending.delete(id);
  if (!approve) {
    p.reject(new Error('the user rejected the request'));
    return { done: true };
  }
  try {
    const result = await p.exec();
    p.resolve(result);
    return { done: true };
  } catch (e) {
    p.reject(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}

// ---- account info ----
async function accountInfo() {
  const addr = engine.currentAddress(false);
  return {
    network: engine.getNetworkName(),
    address: addr.address,            // shared tb1: receives Sequentia assets AND parent-chain BTC
    openampAid: openamp.aid() || null,
  };
}

async function requireUnlockedAndConnected(origin) {
  if (!(await sessionMnemonic())) throw new Error('the wallet is locked');
  await engine.ensureOpen();
  if (!(await perms.isConnected(origin))) throw new Error('this site is not connected; call connect first');
}

// For approval-gated methods: only the connection is checked up front. A
// locked wallet is handled by the approval window itself (it shows its unlock
// card first), so the request never dies with a bare 'locked' error.
async function requireConnected(origin) {
  if (!(await perms.isConnected(origin))) throw new Error('this site is not connected; call connect first');
}
async function ensureOpenOrThrow() {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
}

// ---- the method table ----
export async function handleDappRequest(origin, method, params = {}) {
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error('bad origin');

  switch (method) {
    case 'getCapabilities':
      return {
        provider: 'sequentia-wallet-extension',
        version: chrome.runtime.getManifest().version,
        network: engine.getNetworkName(),
        methods: ['connect', 'getAccounts', 'getNetwork', 'getBalances', 'getAddress',
          'signPset', 'signMessage', 'broadcast', 'createInvoice', 'payInvoice',
          'getUtxos', 'lnChannels', 'lnRequestInbound'],
        events: ['accountsChanged', 'disconnect'],
      };

    case 'getNetwork':
      return { network: engine.getNetworkName() };

    case 'getAccounts': {
      // Silent: never prompts. Empty until connected AND unlocked.
      if (!(await perms.isConnected(origin))) return { accounts: [] };
      if (!(await sessionMnemonic())) return { accounts: [] };
      await engine.ensureOpen();
      return { accounts: [await accountInfo()] };
    }

    case 'connect': {
      if (await perms.isConnected(origin)) {
        if (!(await sessionMnemonic())) {
          // Connected but locked: the approval window doubles as an unlock prompt.
          return requestApproval(origin, 'unlock', { text: 'Unlock your wallet to continue with ' + origin }, async () => {
            await engine.ensureOpen();
            return await accountInfo();
          });
        }
        await engine.ensureOpen();
        return await accountInfo();
      }
      return requestApproval(origin, 'connect', {
        text: origin + ' wants to connect to your wallet. It will see your address, balances, and activity, and may request signatures (each shown for approval).',
      }, async () => {
        await engine.ensureOpen();
        await perms.grant(origin);
        return await accountInfo();
      });
    }

    case 'getBalances': {
      await requireUnlockedAndConnected(origin);
      await engine.syncIfStale();
      const b = await engine.balances();
      const oamp = {};
      for (const [id, atoms] of Object.entries(openamp.balancesMap())) oamp['oamp:' + id] = atoms;
      return { assets: b.seq, btc: b.btc, openamp: oamp };
    }

    case 'getUtxos': {
      // Silent read: the DEX composes swap PSETs from these and returns them
      // through signPset, where the user approves the actual spend.
      await requireUnlockedAndConnected(origin);
      await engine.syncIfStale();
      let utxos = engine.utxosSerialized();
      if (params.asset) utxos = utxos.filter((u) => u.asset === params.asset);
      return { utxos };
    }

    case 'lnChannels': {
      // Silent read: per-asset Lightning capacity (the LNDEX prerequisite).
      await requireUnlockedAndConnected(origin);
      const b = await engine.balances();
      return await ln.channelsSerialized(Object.keys(b.seq));
    }

    case 'lnRequestInbound': {
      await requireConnected(origin);
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const atoms = String(params.amount ?? '');
      if (!/^\d+$/.test(atoms) || BigInt(atoms) <= 0n) throw new Error('amount (atoms) is required');
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'lnRequestInbound', {
        text: origin + ' asks your wallet to request inbound Lightning capacity.',
        detail: 'Inbound capacity to receive up to ' + engine.fmt(atoms, kind === 'BTC' ? 'BTC' : kind) + ' ' + ticker + ' over Lightning. This may open or extend a channel to your hosted node.',
      }, async () => { await ensureOpenOrThrow(); return await ln.requestInbound({ kind, atoms }); });
    }

    case 'getAddress': {
      await requireUnlockedAndConnected(origin);
      const a = engine.currentAddress(!!params.confidential);
      return { address: a.address, index: a.index };
    }

    case 'signMessage': {
      await requireConnected(origin);
      const message = String(params.message ?? '');
      if (!message) throw new Error('message is required');
      return requestApproval(origin, 'signMessage', {
        text: origin + ' asks you to sign a message.',
        message,
      }, async () => { await ensureOpenOrThrow(); return { signature: engine.signMessage(message) }; });
    }

    case 'signPset': {
      await requireConnected(origin);
      const psetB64 = String(params.pset ?? '');
      if (!psetB64) throw new Error('pset is required');
      const effect = engine.describePset(psetB64);
      const display = { text: origin + ' asks you to sign a Sequentia transaction (PSET).', pset: psetB64.slice(0, 120) + '…' };
      if (effect && effect.deltas) {
        display.deltas = Object.entries(effect.deltas).map(([h, v]) => ({
          ticker: A.assetMeta(h).ticker, atoms: v, precision: A.assetMeta(h).precision || 0,
        }));
        if (effect.fee != null) display.fee = effect.fee;
      } else {
        display.warning = 'The wallet could not fully decode this PSET; only sign it if you trust this site.';
      }
      return requestApproval(origin, 'signPset', display, async () => { await ensureOpenOrThrow(); return { pset: await engine.signPset(psetB64) }; });
    }

    case 'broadcast': {
      // Relaying an ALREADY-SIGNED transaction to the network; signing itself
      // was the approved step, so no extra prompt here.
      await requireUnlockedAndConnected(origin);
      return engine.broadcastRaw({ chain: params.chain, hex: params.hex, psetB64: params.pset });
    }

    case 'createInvoice': {
      await requireConnected(origin);
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const atoms = String(params.amount ?? '');
      if (!/^\d+$/.test(atoms) || BigInt(atoms) <= 0n) throw new Error('amount (atoms) is required');
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'createInvoice', {
        text: origin + ' asks your wallet to create a Lightning invoice.',
        detail: 'Receive ' + engine.fmt(atoms, kind === 'BTC' ? 'BTC' : kind) + ' ' + ticker + ' over Lightning.',
      }, async () => { await ensureOpenOrThrow(); return await ln.createInvoice({ kind, atoms, memo: params.memo ? String(params.memo).slice(0, 90) : undefined }); });
    }

    case 'payInvoice': {
      await requireConnected(origin);
      const bolt11 = String(params.bolt11 ?? '');
      if (!bolt11) throw new Error('bolt11 is required');
      const kind = params.asset && params.asset !== 'BTC' ? String(params.asset) : 'BTC';
      const ticker = kind === 'BTC' ? 'BTC' : A.assetMeta(kind).ticker;
      return requestApproval(origin, 'payInvoice', {
        text: origin + ' asks you to pay a Lightning invoice from your ' + ticker + ' balance.',
        bolt11: bolt11.slice(0, 90) + (bolt11.length > 90 ? '…' : ''),
      }, async () => { await ensureOpenOrThrow(); return await ln.payInvoice({ kind, bolt11 }); });
    }

    default:
      throw new Error('unknown method: ' + method);
  }
}
