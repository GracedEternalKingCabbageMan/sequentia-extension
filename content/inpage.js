// Injected into every page's MAIN world: exposes window.sequentia, the
// Sequentia wallet provider. Requests are relayed via window.postMessage to
// the content script (isolated world), which forwards them to the extension.
// Protocol: doc/PROVIDER.md.
(() => {
  if (window.sequentia && window.sequentia.isSequentia) return;

  const TAG = '__sequentiaWallet';
  let reqSeq = 0;
  const inflight = new Map();      // id -> {resolve, reject}
  const listeners = new Map();     // event -> Set<fn>

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] === undefined) return;
    const m = ev.data;
    if (m[TAG] === 'res') {
      const p = inflight.get(m.id);
      if (!p) return;
      inflight.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error || 'request failed'), { code: m.code }));
    } else if (m[TAG] === 'event') {
      const s = listeners.get(m.event);
      if (s) for (const fn of s) { try { fn(m.data); } catch {} }
    }
  });

  const provider = {
    isSequentia: true,
    network: 'sequentia-testnet',
    request({ method, params } = {}) {
      if (!method || typeof method !== 'string') return Promise.reject(new Error('method is required'));
      const id = 'q' + (++reqSeq) + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
      return new Promise((resolve, reject) => {
        inflight.set(id, { resolve, reject });
        window.postMessage({ [TAG]: 'req', id, method, params: params ?? {} }, window.location.origin);
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      // Tell the content script to open the event channel.
      window.postMessage({ [TAG]: 'listen' }, window.location.origin);
      return provider;
    },
    removeListener(event, fn) {
      const s = listeners.get(event);
      if (s) s.delete(fn);
      return provider;
    },
  };

  Object.defineProperty(window, 'sequentia', { value: Object.freeze(provider), writable: false, configurable: false });
  window.dispatchEvent(new Event('sequentia#initialized'));
})();
