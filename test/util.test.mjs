import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtAtoms, parseAtoms, looksLikeBolt11, hexToBytes, bytesToHex } from '../src/util.js';

test('fmtAtoms / parseAtoms round-trip', () => {
  assert.equal(fmtAtoms(150000000n, 8), '1.5');
  assert.equal(fmtAtoms(0n, 8), '0');
  assert.equal(fmtAtoms(-2n, 0), '-2');
  assert.equal(parseAtoms('1.5', 8), 150000000n);
  assert.equal(parseAtoms('0.00000001', 8), 1n);
  assert.equal(parseAtoms('42', 0), 42n);
  for (const s of ['1.23', '0.5', '1000', '0.00000001']) {
    assert.equal(fmtAtoms(parseAtoms(s, 8), 8), s);
  }
});

test('parseAtoms rejects bad input', () => {
  assert.throws(() => parseAtoms('abc', 8));
  assert.throws(() => parseAtoms('-1', 8));
  assert.throws(() => parseAtoms('1.234', 2), /max 2 decimals/);
  assert.throws(() => parseAtoms('', 8));
});

test('looksLikeBolt11', () => {
  assert.ok(looksLikeBolt11('lntb1u1p0xyzabc'));
  assert.ok(looksLikeBolt11('lnbc10n1pxxxxxx'));
  assert.ok(!looksLikeBolt11('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'));
  assert.ok(!looksLikeBolt11(''));
});

test('hex round-trip', () => {
  const b = hexToBytes('00ff10');
  assert.deepEqual([...b], [0, 255, 16]);
  assert.equal(bytesToHex(b), '00ff10');
  assert.throws(() => hexToBytes('abc'));
});
