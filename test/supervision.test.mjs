import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  supervisionMessage,
  targetHash,
  PAUSE_TARGET,
  RECORD_TAG,
  UNFREEZE_TAG,
} from '../src/supervision.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const sha256d = (b) => sha256(sha256(b));
const hex = (b) => Buffer.from(b).toString('hex');

// BIP340's tagged hash, which is what the node's CHashWriter(TaggedHash(tag))
// produces and what the wallet's signer applies to the message below.
function taggedHash(tag, messageHex) {
  const t = sha256(Buffer.from(tag, 'utf8'));
  return sha256(Buffer.concat([t, t, Buffer.from(messageHex, 'hex')]));
}

// Vectors taken from a Sequentia node running the supervised-assets rules
// (elementsregtest, -supervisedassetsheight=1), by calling the RPCs an issuer
// would call. If the wallet's reconstruction ever drifts from the node's, the
// signature verifies against nothing on chain, and it is these that catch it.
const SPK = '00143d7a556a08a9901d2067220b8ae085c0eb5dc667'; // ert1q84a926sg4xgp6gr8yg9c4cy9cr44m3n8a2ktua
const ASSET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddee01';
const TXID = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';

test('freeze: matches getsupervisionrecordhash from the node', () => {
  const { tag, messageHex } = supervisionMessage({
    kind: 'freeze', asset: ASSET, target: targetHash(sha256d, SPK), txid: TXID, vout: 3,
  });
  assert.equal(tag, RECORD_TAG);
  assert.equal(
    hex(taggedHash(tag, messageHex)),
    'fab90341268547d757607cd23a472e288bce4618bdc2d5ec62b8a2513e81b6ba'
  );
});

test('pause: a freeze naming every script, matches the node', () => {
  const { tag, messageHex } = supervisionMessage({
    kind: 'pause', asset: ASSET, target: PAUSE_TARGET, txid: TXID, vout: 3,
  });
  assert.equal(
    hex(taggedHash(tag, messageHex)),
    '98fd43288339b76d0be571c884a1de9a951a0f4437a3a5e256f7c19b96635649'
  );
});

test('unfreeze: matches getsupervisionunfreezehash from the node', () => {
  // The node takes the target as its DISPLAY hex here and reverses it, so the
  // internal bytes are the same ones a freeze names.
  const displayTarget = 'aabbccddeeff00112233445566778899aabbccddeeff001122334455667788ff';
  const target = Buffer.from(displayTarget, 'hex').reverse();
  const { tag, messageHex } = supervisionMessage({
    kind: 'unfreeze', asset: ASSET, target: new Uint8Array(target), txid: TXID, vout: 7,
  });
  assert.equal(tag, UNFREEZE_TAG);
  assert.equal(
    hex(taggedHash(tag, messageHex)),
    '2a625161e732dffb85b363eb50807d80fe446caefe0c88185d39bc8a61abf50d'
  );
});

test('the target of a freeze is sha256d of the scriptPubKey, unreversed', () => {
  assert.equal(hex(targetHash(sha256d, SPK)), hex(sha256d(Buffer.from(SPK, 'hex'))));
});

// Byte order is the failure this module exists to prevent, so it is asserted
// directly rather than only through the digests.
test('asset and txid are serialized in the node internal order', () => {
  const { messageHex } = supervisionMessage({
    kind: 'freeze', asset: ASSET, target: PAUSE_TARGET, txid: TXID, vout: 0,
  });
  const bytes = Buffer.from(messageHex, 'hex');
  assert.equal(bytes.length, 1 + 32 + 32 + 32 + 4);
  assert.equal(bytes[0], 1, 'FREEZE is kind 1');
  assert.equal(hex(bytes.subarray(1, 33)), hex(Buffer.from(ASSET, 'hex').reverse()));
  assert.equal(hex(bytes.subarray(65, 97)), hex(Buffer.from(TXID, 'hex').reverse()));
});

test('the vout is a little-endian u32', () => {
  const { messageHex } = supervisionMessage({
    kind: 'freeze', asset: ASSET, target: PAUSE_TARGET, txid: TXID, vout: 258,
  });
  assert.equal(Buffer.from(messageHex, 'hex').subarray(97).toString('hex'), '02010000');
});

test('malformed fields are refused rather than silently mis-signed', () => {
  const ok = { kind: 'freeze', asset: ASSET, target: PAUSE_TARGET, txid: TXID, vout: 0 };
  assert.throws(() => supervisionMessage({ ...ok, asset: 'ab' }), /32 bytes/);
  assert.throws(() => supervisionMessage({ ...ok, txid: 'zz'.repeat(32) }), /hex/);
  assert.throws(() => supervisionMessage({ ...ok, vout: -1 }), /u32/);
  assert.throws(() => supervisionMessage({ ...ok, target: new Uint8Array(31) }), /32 bytes/);
  assert.throws(() => supervisionMessage({ ...ok, kind: 'rotate' }), /freeze, pause or unfreeze/);
});
