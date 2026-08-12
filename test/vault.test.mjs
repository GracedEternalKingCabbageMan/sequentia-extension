import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetChromeStub } from './helpers/chrome-stub.mjs';
import { vaultExists, vaultCreate, vaultUnlock, vaultLock, sessionMnemonic, vaultDestroy } from '../src/vault.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(() => resetChromeStub());

test('create -> lock -> unlock round-trip', async () => {
  assert.equal(await vaultExists(), false);
  await vaultCreate(PHRASE, 'correct horse battery');
  assert.equal(await vaultExists(), true);
  assert.equal(await sessionMnemonic(), PHRASE);

  await vaultLock();
  assert.equal(await sessionMnemonic(), null);

  const back = await vaultUnlock('correct horse battery');
  assert.equal(back, PHRASE);
  assert.equal(await sessionMnemonic(), PHRASE);
});

test('wrong password fails, session stays locked', async () => {
  await vaultCreate(PHRASE, 'correct horse battery');
  await vaultLock();
  await assert.rejects(() => vaultUnlock('wrong'), /wrong password/);
  assert.equal(await sessionMnemonic(), null);
});

test('normalizes whitespace in the phrase', async () => {
  await vaultCreate('  abandon   abandon\tabandon abandon abandon abandon abandon abandon abandon abandon abandon about ', 'password123');
  assert.equal(await sessionMnemonic(), PHRASE);
});

test('short password rejected', async () => {
  await assert.rejects(() => vaultCreate(PHRASE, 'short'), /at least 8/);
});

test('destroy requires the password and wipes everything', async () => {
  await vaultCreate(PHRASE, 'correct horse battery');
  await assert.rejects(() => vaultDestroy('nope'), /wrong password/);
  await vaultDestroy('correct horse battery');
  assert.equal(await vaultExists(), false);
  assert.equal(await sessionMnemonic(), null);
});
