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

## v0.2 methods (added for the SeqDEX site)

### `getUtxos({ asset? })` — silent, requires connection
The wallet's unspent outputs, optionally filtered to one asset:
```js
{ utxos: [{ txid, vout, asset, value, scriptPubkey, address, height }] }
```
`value` is an atoms string. The DEX composes swap PSETs from these and sends
them back through `signPset`, where the user approves the actual spend — so
this read reveals holdings the origin could already infer from
`getBalances`, never spend authority.

### `lnChannels()` — silent, requires connection
Per-asset Lightning capacity on the user's own channels — the LNDEX
prerequisite check:
```js
{ deployed: true, channels: [{ kind: 'BTC' | '<assetHex>', scid, state,
                               spendable: '<atoms>', receivable: '<atoms>' | null }] }
```

### `lnRequestInbound({ amount, asset? })` — approval per request
Requests inbound Lightning capacity (JIT liquidity from the LSP) so the
wallet can RECEIVE up to `amount` atoms of `asset` (default BTC) over
Lightning. May provision or extend a channel to the user's hosted node.
Phase one of the channel marketplace.

## DEX taker methods

For both methods the wallet NEVER trusts the site's numbers: the site names
an offer (pair + `offerId` + take size) and the wallet re-fetches that offer
from the order-book relay itself, recomputes the exact amounts with the
daemon's proRata / slice math, and shows those in the approval window.

### `dexFillOnchain({ base, quote, offerId, takeBase, mount? })` — approval per request
Fills a resting same-chain order (maker co-signs over the relay courier; the
wallet signs and broadcasts the atomic swap transaction). `takeBase` is the
take size in base-asset atoms (partial fills settle at the offer's exact
ratio). `mount: 'conf'` fills on the confidential book instead: the wallet
receives to a blinded address and the trade settles as a blinded
transaction. Returns `{ txid, paid: {asset, atoms}, received: {asset, atoms} }`.

### `dexSwapLn({ base, quote, offerId, takeAtoms? })` — approval per request
LNDEX taker swap: both legs travel over the user's OWN hosted Lightning
nodes (device-co-signed; the LSP routes but cannot move funds). `quote` is
`'BTC'` for a cross-chain market or an asset id for asset-to-asset. Omitting
`takeAtoms` lifts the whole offer. Returns
`{ settled, direction, baseAtoms, quoteAtoms, preimage, paymentHash }`.
Instant and final on settlement; on a stall nothing moves.

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

## dexMarketOrder

`request({ method: 'dexMarketOrder', params: { room, base, quote, side, baseAtoms } })`

One-approval market order. The wallet re-fetches the room's order book itself,
plans a walk across the opposing resting orders best-first (bounded at 5% past
the best price), and shows a single aggregate approval: total paid, total
received, number of orders walked. After approval the walk executes inside the
wallet's persistent engine; the call returns `{ jobId, pending: true }` and the
site polls `dexJobResult` exactly as for `dexSwapLn`. The finished result is
`{ market: true, baseAtoms, quoteAtoms, slices: [{ ok, offerId, ... }] }` —
a failed slice is skipped, never retried blind, and never fails the whole
order while any slice settled.

- `room`: `'ln'` (pure-Lightning book) — other rooms not yet served.
- `base`: 32-byte hex asset id. `quote`: 32-byte hex or `'BTC'`.
- `side`: `'buy' | 'sell'` of the base asset. `baseAtoms`: decimal string.

## dexPlaceLimit

`request({ method: 'dexPlaceLimit', params: { room, base, quote, side, baseAtoms, limitQuoteAtoms } })`

Limit order, fill-then-rest. `limitQuoteAtoms` is the quote-side total for the
whole `baseAtoms` (the exact integer price). Anything the book already crosses
at your price or better fills immediately (same engine as a market order,
bounded by the limit instead of slippage); the remainder RESTS on the book as
a live offer served by the wallet itself: the wallet answers lifts, registers
holds on its own node, pays the counter-leg, settles — the full maker
choreography, atomically per fill. One approval covers both halves.

Presence is honest: the resting offer lives while the wallet's engine lives
(offers expire within the hour otherwise). Poll `dexJobResult` for state:
`{ resting: true, remaining, filledAtoms, ... }` while resting, then a final
`{ done: true, result: { rested, baseAtoms, quoteAtoms, fills } }` when fully
matched.
