// Content script (isolated world): relays window.sequentia requests from the
// page to the background service worker, and wallet events back to the page.
(() => {
  const TAG = '__sequentiaWallet';
  let eventPort = null;

  function ensureEventPort() {
    if (eventPort) return;
    try {
      eventPort = chrome.runtime.connect({ name: 'seq-dapp' });
      eventPort.onMessage.addListener((m) => {
        if (m && m.event) window.postMessage({ [TAG]: 'event', event: m.event, data: m.data }, window.location.origin);
      });
      eventPort.onDisconnect.addListener(() => { eventPort = null; });
    } catch { eventPort = null; }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] === undefined) return;
    const m = ev.data;
    if (m[TAG] === 'listen') { ensureEventPort(); return; }
    if (m[TAG] !== 'req') return;
    chrome.runtime.sendMessage({ scope: 'dapp', method: m.method, params: m.params }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        window.postMessage({ [TAG]: 'res', id: m.id, ok: false, error: err.message }, window.location.origin);
        return;
      }
      if (resp && resp.ok) {
        // A successful connect implies the page will want events.
        if (m.method === 'connect') ensureEventPort();
        window.postMessage({ [TAG]: 'res', id: m.id, ok: true, result: resp.result }, window.location.origin);
      } else {
        window.postMessage({ [TAG]: 'res', id: m.id, ok: false, error: (resp && resp.error) || 'request failed' }, window.location.origin);
      }
    });
  });
})();
