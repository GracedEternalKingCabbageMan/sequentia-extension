// Per-origin site permissions. A site must be connected (user-approved) before
// any account-revealing or signing method resolves. Stored in
// chrome.storage.local so decisions survive restarts until revoked.

import { stGet, stSet } from './util.js';

const KEY = 'ext.sites';

export async function sites() {
  return (await stGet('local', KEY)) || {};
}
export async function isConnected(origin) {
  const s = await sites();
  return !!s[origin];
}
export async function grant(origin) {
  const s = await sites();
  s[origin] = { connectedAt: Date.now() };
  await stSet('local', KEY, s);
}
export async function revoke(origin) {
  const s = await sites();
  delete s[origin];
  await stSet('local', KEY, s);
}
