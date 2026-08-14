// Boot shim: import the engine with a version-busted URL. This file is
// deliberately VERSION-INDEPENDENT (safe to cache forever): the version rides
// the document URL (?v=), set by the dispatcher, so only offscreen.js?v=<ver>
// varies and Brave's chrome-extension:// cache can never serve a stale engine.
// (Inline module scripts are blocked by the extension CSP; this must be a file.)
const v = new URLSearchParams(location.search).get('v') || Date.now();
import('./offscreen.js?v=' + encodeURIComponent(v)).catch((e) => {
  chrome.runtime.sendMessage({ scope: 'oln-store', key: 'ext.olnjob.loader-err',
    val: { done: true, ok: false, error: 'engine import failed: ' + String((e && e.message) || e), at: Date.now() } }).catch(() => {});
});
