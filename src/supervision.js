// The message a supervised-asset freeze commits to, rebuilt here.
//
// A supervised asset (a freely-tradable one, whose freezes the network itself
// enforces) is governed by an OPERATIONAL key the asset id commits to. To freeze
// a holder, that key signs a message the node computes; a website asking this
// wallet to sign it could otherwise only hand over 32 opaque bytes, and signing
// a digest chosen by someone else is the one thing the enclave key must never
// do, because it is half of the 2-of-2 every restricted asset sits behind.
//
// It does not have to be opaque. The node's message is itself a BIP340 TAGGED
// hash over a short, fixed layout, so the wallet can rebuild it from the fields
// a person can actually read: which asset, which address, and which input the
// record's transaction spends. That is what this module does. The wallet then
// signs its OWN reconstruction, shows the fields, and a site that lies about any
// of them produces a signature the network rejects rather than a freeze the
// issuer did not intend.
//
// The layout is Sequentia's, from src/supervision.cpp:
//
//   freeze  tagged("Sequentia/SupervisionRecord",
//                  kind(1) || asset(32) || target(32) || txid(32) || vout(4 LE))
//   unfreeze tagged("Sequentia/SupervisionUnfreeze",
//                  txid(32) || vout(4 LE) || asset(32) || target(32))
//
// Every 32-byte field is in the node's INTERNAL byte order, which is the reverse
// of the hex an explorer or an RPC prints for an asset id or a txid. The target
// is the exception that proves the rule: it is sha256d of the scriptPubKey, used
// as the raw digest, because that is how the node computes it rather than how it
// displays it. Getting this backwards produces a signature that verifies against
// nothing, for reasons that look like anything but byte order, so the unit tests
// pin all three shapes to vectors taken from the node itself.
//
// Kept free of any wasm or extension import so it is unit-testable on its own.

export const RECORD_TAG = 'Sequentia/SupervisionRecord';
export const UNFREEZE_TAG = 'Sequentia/SupervisionUnfreeze';

// SupervisionRecordKind in src/supervision.h. A pause is a FREEZE naming every
// script at once, which it does with an all-zero target, so it shares the kind.
const KIND_FREEZE = 1;

const hexRe = /^[0-9a-f]*$/i;

function bytesFromHex(hex, name, len) {
  const h = String(hex || '');
  if (!hexRe.test(h) || h.length % 2) throw new Error(name + ' must be hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (len != null && out.length !== len) throw new Error(name + ' must be ' + len + ' bytes');
  return out;
}

// Display hex to the node's internal order.
function internal(hex, name) {
  return bytesFromHex(hex, name, 32).reverse();
}

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function leU32(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error('vout must be a u32');
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

// The target a freeze names: sha256d of the scriptPubKey, as the node computes
// it (SupervisionTargetHash), in internal order. `sha256d` is injected so this
// module stays free of any hashing dependency of its own.
export function targetHash(sha256d, scriptHex) {
  return sha256d(bytesFromHex(scriptHex, 'scriptPubKey'));
}

// The all-scripts wildcard a pause names (SUPERVISION_PAUSE_TARGET).
export const PAUSE_TARGET = new Uint8Array(32);

// Build the tag and message for one supervision action. `target` is the 32-byte
// internal-order target (from targetHash, or PAUSE_TARGET for a pause).
export function supervisionMessage({ kind, asset, target, txid, vout }) {
  const assetBytes = internal(asset, 'asset');
  const txidBytes = internal(txid, 'txid');
  const n = leU32(vout);
  if (!(target instanceof Uint8Array) || target.length !== 32) {
    throw new Error('target must be 32 bytes');
  }
  if (kind === 'freeze' || kind === 'pause') {
    return {
      tag: RECORD_TAG,
      messageHex: toHex(concat([new Uint8Array([KIND_FREEZE]), assetBytes, target, txidBytes, n])),
    };
  }
  if (kind === 'unfreeze') {
    // Spending the freeze record is what lifts it, so the message binds the
    // record's own outpoint rather than a funding input.
    return {
      tag: UNFREEZE_TAG,
      messageHex: toHex(concat([txidBytes, n, assetBytes, target])),
    };
  }
  throw new Error('kind must be freeze, pause or unfreeze');
}
