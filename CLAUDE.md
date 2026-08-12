# CLAUDE.md — sequentia-extension

Chromium MV3 extension wallet for Sequentia + Bitcoin testnet4, built on SWK's
wasm. Read this before changing anything.

## First principles this repo must never violate

1. **Dual-chain, one address.** BTC (testnet4) is a first-class asset; the
   default unblinded Sequentia address IS the Bitcoin address (`tb1…`).
   Never add a Sequentia-only mode.
2. **No privileged asset.** tSEQ is one row among equals; no "native asset"
   labels, headline = portfolio total in the reference currency; a fresh
   wallet shows only a 0 BTC row (zero-balance assets hidden, BTC excepted).
3. **Fee rates are correct as-is.** Fees payable in any priced asset; rate
   units are the fee asset's OWN units/vByte, never "sat/vB" (BTC sends
   excepted). NO 1:1 fallback for unpriced assets — `feeRateFor` throwing is
   the design, not a bug.
4. **Transparent by default.** Confidential (`tsqb1…`) is opt-in per call.
5. **Never blind-sign.** OpenAMP transfers recompute sighashes locally and
   abort on mismatch; dapp PSETs show their decoded effect before signing.

## Architecture invariants

- **`withWollet` is load-bearing** (src/engine.js): wasm-bindgen forbids
  re-entrant `&mut` use; every scan and build→broadcast must go through the
  queue. The message-driven service worker has MORE concurrency than the web
  wallet page had, not less.
- **Own-tx ring**: after every `applyUpdate`, recent own broadcasts are
  re-applied (a stale backend Update otherwise reverts them and later builds
  re-select spent inputs).
- **Scan cache**: IndexedDB persists exactly ONE kind of Update — one computed
  against an EMPTY wollet (from a throwaway scan), aged out weekly. Never
  persist a mid-session incremental update.
- **BigInt never crosses the message boundary** — all RPC amounts are strings.
- **No bundler, no framework, plain ES modules** (matches the web wallet).
  Content scripts: inpage.js runs in the MAIN world, content.js relays.
- The service worker has no `localStorage`; `src/shim.js` provides a
  write-through shim (vendor/seqln.js needs it). Import shim.js first.

## Provenance / sync obligations

- `vendor/btc.js`, `vendor/seqln.js`, `vendor/seqln-keys.js`,
  `vendor/lightning/` are copied from `sequentia-web-wallet` — fix bugs THERE
  and re-copy, don't fork them silently.
- `pkg/` is the SWK `lwk_wasm` build (size-optimized). Rebuild recipe in
  README.md. It is committed deliberately so the extension loads unpacked
  without a Rust toolchain.
- `doc/PROVIDER.md` is the contract with future sites (the standalone DEX).
  `src/provider-router.js` and that document MUST change together.

## Endpoints

All backends live behind `https://sequentiatestnet.com` and are declared in
`src/config.js` (the only place origins may appear) + `manifest.json`
host_permissions. The LSP bearer token there is the shared public testnet-demo
token (already public in sequentia-web-wallet) — not a secret.

## Commands

- Tests: `node --test 'test/*.test.mjs'`
- Syntax sweep: copy each .js to a .mjs and `node --check` it
- Icons: `node scripts/gen-icons.mjs`

## Known limitations (candidates for future work)

- Receiving a Lightning payment needs the device signer online: create the
  invoice from the popup and keep it open until paid (same constraint as the
  web wallet page, surfaced differently by the ephemeral service worker).
- No camera QR scanning (paste or file only). QR display payloads are bare
  addresses (deliberately NOT `Address.QRCodeUri()`, which emits a
  wrong-network `liquidnetwork:` URI).
- RBF/CPFP rescue buttons are not yet ported from the web wallet.
