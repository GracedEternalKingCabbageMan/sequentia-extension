// Copyright (c) 2026 The Sequentia developers
// Distributed under the MIT software license.
//
// A self-contained BIP340 (Schnorr) signer for Bitcoin taproot, in pure JS.
//
// The wallet needs this to sign the Bitcoin half of a Pignus cross-chain
// (BTC-collateral) loan on behalf of a dapp: derive a stable, seed-recoverable
// Pignus Bitcoin key, hand a page its x-only public key, and sign a 32-byte
// taproot sighash the page computed. The bundled SWK wasm exposes no plain
// BIP340 signer (Keypair is behind the simplicity feature), and pulling in that
// feature to get one leaf of functionality is not worth the weight -- this is
// ~120 lines of the same secp256k1 the rest of the stack already trusts, and it
// is pinned byte-for-byte to a vector emitted by the proven Python
// (pignus/adaptor.py) so a signing bug cannot ship silently.

const Pf = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = Pf) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = Pf) {
  let [old_r, r] = [mod(a, m), m], [old_s, s] = [1n, 0n];
  while (r !== 0n) { const q = old_r / r;
    [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return mod(old_s, m);
}
function ptAdd(p1, p2) {
  if (!p1) return p2; if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  let m;
  if (x1 === x2 && y1 === y2) m = mod(3n * x1 * x1 * inv(2n * y1));
  else m = mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(m * m - x1 - x2);
  return [x3, mod(m * (x1 - x3) - y1)];
}
function ptMul(p, k) {
  let r = null, a = p; k = mod(k, N);
  while (k > 0n) { if (k & 1n) r = ptAdd(r, a); a = ptAdd(a, a); k >>= 1n; }
  return r;
}
function liftX(x) {
  const c = mod(x ** 3n + 7n);
  const y = powMod(c, (Pf + 1n) / 4n, Pf);
  if (mod(y * y) !== c) throw new Error("not on curve");
  return [x, (y & 1n) === 0n ? y : Pf - y];
}
function powMod(b, e, m) { let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = mod(r * b, m); b = mod(b * b, m); e >>= 1n; } return r; }

const hexToBytes = (h) => { const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const bytesToHex = (b) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const toBig = (b) => BigInt("0x" + (bytesToHex(b) || "0"));
const be32 = (n) => hexToBytes(mod(n, 2n ** 256n).toString(16).padStart(64, "0"));
function concat(...ps) { let n = 0; for (const p of ps) n += p.length;
  const o = new Uint8Array(n); let i = 0; for (const p of ps) { o.set(p, i); i += p.length; } return o; }

// --- sha256 (sync, pure JS) ---
function sha256(msg) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = msg.length; const withOne = l + 1;
  const k = (56 - withOne % 64 + 64) % 64;
  const total = withOne + k + 8;
  const m = new Uint8Array(total); m.set(msg); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(total - 4, (l * 8) >>> 0);
  dv.setUint32(total - 8, Math.floor(l * 8 / 2 ** 32));
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      const s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h = [ (h[0]+a)>>>0,(h[1]+b)>>>0,(h[2]+c)>>>0,(h[3]+d)>>>0,
          (h[4]+e)>>>0,(h[5]+f)>>>0,(h[6]+g)>>>0,(h[7]+hh)>>>0 ];
  }
  const out = new Uint8Array(32); const odv = new DataView(out.buffer);
  h.forEach((x, i) => odv.setUint32(i * 4, x)); return out;
}
function tagged(tag, data) {
  const t = sha256(new TextEncoder().encode(tag));
  return sha256(concat(t, t, data));
}
function xorBytes(a, b) { const o = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }

/** The Pignus Bitcoin secret, deterministic and recoverable from the seed. */
export function pignusSecret(mnemonic, domain = "pignus/btc-collateral/v1") {
  return sha256(new TextEncoder().encode(domain + "\n" + mnemonic));
}

/** x-only public key of a secret. */
export function xOnlyPubkey(secretHex) {
  const P = ptMul([Gx, Gy], toBig(hexToBytes(secretHex)));
  return bytesToHex(be32(P[0]));
}

/** BIP340 sign a 32-byte message (a taproot sighash), deterministic (aux=0). */
export function signSchnorr(secretHex, msgHex) {
  const d0 = toBig(hexToBytes(secretHex));
  if (!(d0 > 0n && d0 < N)) throw new Error("secret out of range");
  const Pp = ptMul([Gx, Gy], d0);
  const d = (Pp[1] & 1n) === 0n ? d0 : N - d0;
  const msg = hexToBytes(msgHex);
  if (msg.length !== 32) throw new Error("message must be 32 bytes");
  const px = be32(Pp[0]);
  const aux = new Uint8Array(32);                       // deterministic
  const t = xorBytes(be32(d), tagged("BIP0340/aux", aux));
  const rand = tagged("BIP0340/nonce", concat(t, px, msg));
  let k0 = mod(toBig(rand), N);
  if (k0 === 0n) throw new Error("bad nonce");
  const R = ptMul([Gx, Gy], k0);
  const k = (R[1] & 1n) === 0n ? k0 : N - k0;
  const rx = be32(R[0]);
  const e = mod(toBig(tagged("BIP0340/challenge", concat(rx, px, msg))), N);
  const s = mod(k + e * d, N);
  return bytesToHex(concat(rx, be32(s)));
}

export const _sign_internals = { sha256, tagged, xOnlyPubkey };
