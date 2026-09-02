// A website builds a PSET; this wallet has to be able to sign its own inputs
// in it. The signer looks for THIS wallet's key origin on an input, and a site
// cannot write one, so the wallet fills them in itself. These checks are the
// evidence that it does, and that the approval window can still say what the
// transaction does when the whole thing is transparent, which is what a
// covenant settlement looks like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeTransparent, stripBip32 } from '../src/psetbytes.js';

const ROOT = new URL('..', import.meta.url).pathname;

// A buy of a covenant sale, exactly as levod builds one: input 0 is the
// covenant carrying its own final witness, input 1 is the buyer's output; the
// outputs are the treasury credit, the re-rested remainder, the buyer's
// tokens, the buyer's change and the fee. The buyer's script is the one the
// mnemonic below derives at index 0.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const BUYER_SPK = '0014d0c4a3ef09e997b6e99e397e518fe3e41a118ca1';
const PSET = await readFile(new URL('./fixtures/levo-buy.pset', import.meta.url), 'utf8').then((s) => s.trim());

test('a transparent PSET is readable from its bytes', () => {
  const t = describeTransparent(PSET);
  assert.equal(t.inputs.length, 2);
  assert.equal(t.outputs.length, 5);
  assert.equal(t.inputs[1].script, BUYER_SPK);
  assert.equal(t.inputs[1].atoms, 500000000000n);
  assert.equal(t.blindedInputs, false);
  assert.equal(t.fee, 1000000n);
  // Nothing is marked as ours until the wallet adds its key origins.
  assert.deepEqual(t.deltas, {});
  assert.equal(t.outputs[4].fee, true);
  assert.equal(t.outputs[0].asset, '2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de');
});

test('stripping key origins leaves a PSET that still parses', () => {
  const stripped = stripBip32(PSET);
  const t = describeTransparent(stripped);
  assert.equal(t.inputs.length, 2);
  assert.equal(t.outputs.length, 5);
  assert.equal(t.fee, 1000000n);
});

// The rest needs the wasm and a scan: the wallet only recognises its own
// scripts once it has derived them, which is what a scan does. Skipped when
// the network is not reachable.
test('the wallet signs its own input in a site-built PSET', async (t) => {
  const mod = await import(ROOT + 'pkg/lwk_wasm.js');
  await mod.default({ module_or_path: await readFile(ROOT + 'pkg/lwk_wasm_bg.wasm') });
  const { Mnemonic, Network, Signer, Wollet, Pset, EsploraClient } = mod;
  const net = Network.sequentiaTestnet();
  const signer = new Signer(new Mnemonic(MNEMONIC), net);
  const wollet = new Wollet(net, signer.wpkhSlip77Descriptor());
  assert.equal(wollet.address(0).address().toUnconfidential().scriptPubkey().toString(), BUYER_SPK,
    'the fixture was built for this wallet');
  try {
    const update = await new EsploraClient(net, 'https://sequentiatestnet.com/api').fullScan(wollet);
    if (update) wollet.applyUpdate(update);
  } catch (e) {
    t.skip('no network: ' + String(e && e.message).slice(0, 60));
    return;
  }

  // What the shipped wallet used to do: sign without adding the origins.
  assert.throws(() => new Signer(new Mnemonic(MNEMONIC), net).sign(new Pset(PSET)),
    /No signature added/, 'without key origins the signer signs nothing');

  // What it does now. `sign` consumes the PSET it is given, so the copy read
  // for the approval numbers is a second one.
  const detailed = new Pset(PSET);
  detailed.addDetails(wollet);
  const withDetails = describeTransparent(detailed.toString());
  const toSign = new Pset(PSET);
  toSign.addDetails(wollet);
  const signed = signer.sign(toSign);
  const out = stripBip32(signed.toString());
  assert.ok(out.length > PSET.length, 'the signature is in the returned PSET');
  const before = describeTransparent(PSET);
  assert.equal(withDetails.inputs[1].mine, true, 'the buyer input is recognised as ours');
  assert.equal(withDetails.inputs[0].mine, false, 'the covenant input is not');
  assert.equal(before.inputs[1].mine, false);
  // The approval window's numbers: the buyer spends payment asset and receives
  // tokens plus change.
  const deltas = withDetails.deltas;
  assert.equal(deltas['aa'.repeat(32)], 10000000000n, 'tokens received');
  assert.equal(deltas['2a515539da5e6a60caa7766ecd65bac0c10d15717ddd2088844ba58f4d04b9de'], -25001000000n,
    'payment asset spent, change kept');
});
