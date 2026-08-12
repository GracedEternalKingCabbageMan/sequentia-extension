import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetChromeStub } from './helpers/chrome-stub.mjs';
import { sites, isConnected, grant, revoke } from '../src/permissions.js';

beforeEach(() => resetChromeStub());

test('grant / isConnected / revoke lifecycle', async () => {
  const origin = 'https://dex.example.org';
  assert.equal(await isConnected(origin), false);
  await grant(origin);
  assert.equal(await isConnected(origin), true);
  const s = await sites();
  assert.ok(s[origin].connectedAt > 0);
  await revoke(origin);
  assert.equal(await isConnected(origin), false);
});

test('origins are independent', async () => {
  await grant('https://a.example');
  assert.equal(await isConnected('https://b.example'), false);
  await revoke('https://b.example');   // no-op
  assert.equal(await isConnected('https://a.example'), true);
});
