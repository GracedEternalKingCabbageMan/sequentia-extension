# The Sequentia website provider protocol

The extension injects `window.sequentia` into every page. Websites (for
example the upcoming standalone SeqDEX site) use it to connect to the user's
wallet, read balances, and request signatures. There is no other wallet-to-site
channel: sites never see the mnemonic, never sign anything themselves, and
every sensitive operation opens an approval window the user must confirm.

This document is the contract between the extension
(`src/provider-router.js`) and site authors. Keep the two in sync.

## Detection

```js
if (window.sequentia?.isSequentia) { /* wallet available */ }
window.addEventListener('sequentia#initialized', () => { /* injected late */ });
```

## Calling convention

Every call goes through `request`:

```js
const result = await window.sequentia.request({ method, params });
```

Errors reject with an `Error` whose `message` explains the failure (`'the user
rejected the request'`, `'the wallet is locked'`, `'this site is not
connected; call connect first'`, …).

All amounts are **strings of atoms** (the asset's smallest unit; BigInt does
not survive JSON). Asset identifiers are 64-hex Sequentia asset ids, the
literal `'BTC'` for parent-chain Bitcoin, or `'oamp:<assetId>'` for OpenAMP
restricted assets.

## Connection model

- `connect` prompts the user once per origin; the grant persists until revoked
  in the wallet's Settings tab.
- Read methods (`getBalances`, `getAddress`) require the origin to be
  connected AND the wallet unlocked; they never prompt.
- Signing / paying methods additionally open an approval window per request.
- If the wallet is locked when a prompt-worthy request arrives, the approval
  window doubles as an unlock screen.

## Methods

### `getCapabilities()` — silent
Returns provider metadata; safe to call before connecting.
```js
{ provider: 'sequentia-wallet-extension', version, network: 'sequentia-testnet',
  methods: [...], events: ['accountsChanged', 'disconnect'] }
```

### `getNetwork()` — silent
`{ network: 'sequentia-testnet' }`

### `connect()` — prompts once per origin
```js
{ network: 'sequentia-testnet',
  address: 'tb1…',        // the shared dual-chain address: receives Sequentia assets AND parent-chain BTC
  openampAid: '…' | null } // the wallet's OpenAMP account id, if registered
```

### `getAccounts()` — silent
Same account object inside `{ accounts: [...] }`, or `{ accounts: [] }` when
not connected or locked. Use it to restore a session without prompting.

### `getBalances()` — silent, requires connection
```js
{ assets: { '<assetHexId>': '<atoms>' },   // Sequentia on-chain, tSEQ included under its id
  btc: '<sats>',                           // parent-chain Bitcoin testnet4
  openamp: { 'oamp:<id>': '<atoms>' } }    // restricted assets
```

### `getAddress({ confidential? })` — silent, requires connection
`{ address, index }`. Default is the standard `tb1…` form (identical on both
chains); `confidential: true` returns the opt-in blinded `tsqb1…` form.

### `signPset({ pset })` — approval per request
`pset` is a base64 PSET (Elements partially signed transaction). The wallet
shows its decoded effect on the user's balances when it can decode it, signs
with the wallet keys, and returns `{ pset }` — signed but **not** finalized or
broadcast, so a DEX can compose partial signatures (resting orders, swaps).
Per-input sighash flags embedded in the PSET are honored, which is what makes
signed resting orders (SINGLE|ANYONECANPAY-style intents) possible.

### `signMessage({ message })` — approval per request
`{ signature }` over the given UTF-8 message with the wallet's key.

### `broadcast({ pset? , hex?, chain? })` — silent, requires connection
Relays an already-signed transaction: either a finalized-able `pset` (base64)
or a raw `hex`; `chain: 'bitcoin'` sends `hex` to testnet4 instead of
Sequentia. Returns `{ txid }`. No prompt: signing was the approved step.

### `createInvoice({ amount, asset?, memo? })` — approval per request
Creates a Lightning invoice on the user's own hosted node. `asset` omitted or
`'BTC'` → BTC over Lightning; else a fee-priced Sequentia asset id (OpenAMP
assets cannot travel over Lightning). Returns `{ bolt11 }`.

### `payInvoice({ bolt11, asset? })` — approval per request
Pays a bolt11 invoice from the user's Lightning balance for that asset
(default BTC). Returns `{ paid: true, preimage }`.

## Events

Subscribe with `window.sequentia.on(event, handler)`:

- `accountsChanged` — `{ accounts: [] }` fires when the wallet locks (site
  should treat the session as suspended).
- `disconnect` — `{}` fires when the user revokes this site in Settings.

## Design notes for the DEX

- Match rail-blind, settle by rail: the provider deliberately exposes both the
  on-chain surface (`signPset`/`broadcast`) and the Lightning surface
  (`createInvoice`/`payInvoice`), so the DEX site can implement same-chain
  atomic swaps, covenant resting orders, and LN legs against one wallet API.
- The wallet enforces first principles the site must not fight: no privileged
  asset (fee selection is the wallet's), transparent-by-default addresses,
  amounts always in atoms.
- Anything not yet covered here (for example HTLC secret management for
  cross-chain swaps) should be proposed as a protocol extension in this file
  before being built into the site.
