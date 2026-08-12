// Minimal chrome.* stub so storage-backed modules run under node --test.
const areas = { local: new Map(), session: new Map() };

function mkArea(map) {
  return {
    async get(key) {
      if (typeof key === 'string') return map.has(key) ? { [key]: map.get(key) } : {};
      const out = {};
      for (const k of key) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) map.set(k, structuredClone(v)); },
    async remove(key) { map.delete(key); },
  };
}

globalThis.chrome = {
  storage: { local: mkArea(areas.local), session: mkArea(areas.session) },
  alarms: { async create() {}, onAlarm: { addListener() {} } },
  runtime: { id: 'test', getManifest: () => ({ version: '0.0.0-test' }) },
};

export function resetChromeStub() {
  areas.local.clear();
  areas.session.clear();
}
