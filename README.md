# Sequentia Wallet — browser extension

A non-custodial Chromium (Manifest V3) extension wallet for the Sequentia
network and Bitcoin testnet4, built on [SWK](https://github.com/GracedEternalKingCabbageMan/SWK)
(the Sequentia Wallet Kit).

Like every Sequentia wallet it is **dual-chain**: one BIP39 seed drives a full
Bitcoin testnet4 wallet and the Sequentia wallet side by side, and both chains
share the **same `tb1…` address** (Sequentia is transparent by default;
confidential `tsqb1…` addresses are an explicit opt-in).

## Features

- **Balances** — BTC (parent chain, always shown) plus every held Sequentia
  asset and OpenAMP restricted asset, one uniform row each, with a portfolio
  headline in a user-chosen reference currency. No asset is privileged; the
  Sequence token (tSEQ) is one row among equals.
- **Send / receive** — on-chain sends on both chains with any-asset fees
  (fee rates in the fee asset's own units per vByte), OpenAMP transfers with
  local sighash verification (never blind-signs), QR receive with the bare
  address as payload.
- **Transaction history** — Sequentia, Bitcoin, and restricted-asset transfers.
- **Lightning** — send and receive BTC and fee-priced Sequentia assets over
  the hosted SeqLN rail (Tier-2: keyless hosted nodes, this device co-signs
  everything; the LSP can route but never move funds), plus non-custodial
  move-to-Lightning / move-to-chain channel management.
- **Website connections** — injects `window.sequentia` so sites (the upcoming
  standalone SeqDEX among them) can connect, read balances, and request
  signatures behind per-origin permissions and per-request approval windows.
  Protocol spec: [doc/PROVIDER.md](doc/PROVIDER.md).

Deliberately **not** included (use the [web wallet](https://sequentiatestnet.com/wallet)):
staking, asset issuance, and the built-in DEX.

## Security model

- The mnemonic is stored AES-256-GCM-encrypted under a password
  (PBKDF2-SHA256, 310k iterations) in `chrome.storage.local`; while unlocked
  the plaintext lives only in `chrome.storage.session` (memory-backed,
  extension-only, cleared when the browser exits). Auto-lock defaults to
  30 minutes.
- Sites never see the seed and cannot sign anything themselves; every
  signature request opens an approval window showing the decoded effect.
- OpenAMP transfers recompute every sighash locally from explorer-resolved
  prevouts and abort on any mismatch.

## Install (developer load)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this repository's root directory.

The wasm artifacts (`pkg/`, `vendor/lightning/pkg/`) are committed, so no
build step is needed to load the extension.

## Development

- Plain ES modules, no bundler, no framework (same constraint as the web
  wallet). The background service worker owns all wallet state; the popup and
  approval pages are thin RPC clients.
- Tests: `node --test 'test/*.test.mjs'`
- Icons: `node scripts/gen-icons.mjs`
- Rebuild the SWK wasm (needs the SWK checkout + clang):
  ```sh
  cd ../SWK/lwk_wasm
  CARGO_PROFILE_RELEASE_OPT_LEVEL=z wasm-pack build --target web --release --out-dir pkg_ext
  cp pkg_ext/{lwk_wasm.js,lwk_wasm.d.ts,lwk_wasm_bg.wasm,package.json} ../../sequentia-extension/pkg/
  ```

## Repository layout

```
manifest.json          MV3 manifest (module SW, wasm-unsafe-eval CSP)
background.js          service worker: message router, lifecycle, overview
src/                   engine (SWK wasm, dual-chain), vault, assets, openamp,
                       ln, permissions, provider router
content/               inpage provider (MAIN world) + relay (isolated world)
popup/                 wallet UI     approval/  site-request approval window
vendor/                modules shared with sequentia-web-wallet (btc.js,
                       seqln.js, seqln-keys.js, lightning signer SDK)
pkg/                   SWK lwk_wasm build (committed)
doc/PROVIDER.md        the website provider protocol
```

Part of the Sequentia testnet ecosystem: https://sequentiatestnet.com
