// Encrypted mnemonic vault + lock state.
//
// The web wallet stores the phrase in plaintext localStorage; the extension
// does not. The mnemonic is encrypted with AES-256-GCM under a key derived
// from the user's password (PBKDF2-SHA256, 310k iterations) and stored in
// chrome.storage.local. While unlocked, the plaintext phrase lives only in
// chrome.storage.session (memory-backed, extension-context-only, cleared when
// the browser exits), so the ephemeral service worker can restart without
// re-prompting. Locking clears session storage.

import { stGet, stSet, stDel } from './util.js';
import { AUTOLOCK_MINUTES_DEFAULT } from './config.js';

const VAULT_KEY = 'ext.vault';
const SESSION_KEY = 'ext.session.mnemonic';
const PBKDF2_ITER = 310000;

const te = new TextEncoder();
const td = new TextDecoder();

function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function vaultExists() {
  return !!(await stGet('local', VAULT_KEY));
}

// Create (or replace) the vault from a validated mnemonic + password, and leave
// the wallet unlocked. Caller validates the mnemonic (wasm Mnemonic) first.
export async function vaultCreate(mnemonic, password) {
  if (!password || password.length < 8) throw new Error('choose a password of at least 8 characters');
  const phrase = mnemonic.trim().replace(/\s+/g, ' ');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITER);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(phrase));
  await stSet('local', VAULT_KEY, {
    v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER,
    salt: b64(salt), iv: b64(iv), ct: b64(ct),
  });
  await stSet('session', SESSION_KEY, phrase);
  return phrase;
}

// Decrypt with the password; on success the phrase is cached in session storage.
export async function vaultUnlock(password) {
  const v = await stGet('local', VAULT_KEY);
  if (!v) throw new Error('no wallet exists yet');
  const key = await deriveKey(password, unb64(v.salt), v.iter || PBKDF2_ITER);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct));
  } catch {
    throw new Error('wrong password');
  }
  const phrase = td.decode(pt);
  await stSet('session', SESSION_KEY, phrase);
  return phrase;
}

// The unlocked phrase, or null when locked. Never throws.
export async function sessionMnemonic() {
  try { return await stGet('session', SESSION_KEY); } catch { return null; }
}

export async function vaultLock() {
  await stDel('session', SESSION_KEY);
}

// Destroy the vault entirely (requires the password as a deliberate barrier).
export async function vaultDestroy(password) {
  await vaultUnlock(password);   // throws on wrong password
  await stDel('local', VAULT_KEY);
  await stDel('session', SESSION_KEY);
}

// ---- auto-lock ----
export async function armAutoLock() {
  const settings = (await stGet('local', 'ext.settings')) || {};
  const mins = settings.autoLockMin || AUTOLOCK_MINUTES_DEFAULT;
  await chrome.alarms.create('autolock', { delayInMinutes: mins });
}

export async function touchAutoLock() {
  // Re-arm on activity so the timer is "minutes since last use".
  if (await sessionMnemonic()) await armAutoLock();
}
