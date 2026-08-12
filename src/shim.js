// Synchronous localStorage shim for the MV3 service worker.
//
// vendor/seqln.js persists a small device-side channel-store backstop blob via
// localStorage (MAC'd to the signing seed, no secrets). Service workers have no
// localStorage, so this installs a Map-backed synchronous shim that writes
// through to chrome.storage.local (async, best-effort) and is hydrated from it
// before any Lightning code runs. Call hydrateShim() once at engine start.

const KEY = 'ext.lsShim';
const mem = new Map();
let hydrated = false;

function persist() {
  const obj = {};
  for (const [k, v] of mem) obj[k] = v;
  chrome.storage.local.set({ [KEY]: obj }).catch(() => {});
}

export async function hydrateShim() {
  if (hydrated) return;
  try {
    const o = await chrome.storage.local.get(KEY);
    const saved = o[KEY] || {};
    for (const [k, v] of Object.entries(saved)) if (!mem.has(k)) mem.set(k, v);
  } catch {}
  hydrated = true;
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(String(k)) ? mem.get(String(k)) : null),
    setItem: (k, v) => { mem.set(String(k), String(v)); persist(); },
    removeItem: (k) => { mem.delete(String(k)); persist(); },
    clear: () => { mem.clear(); persist(); },
    key: (i) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
}
