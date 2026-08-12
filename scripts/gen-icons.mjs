// Generates the extension icons: an antialiased gold disc (brand #ffc629) on
// a transparent background, with a subtle darker ring. Pure Node (zlib), no
// image libraries. Run: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GOLD = [255, 198, 41], DARK = [46, 34, 2];
function disc(size) {
  const c = (size - 1) / 2, R = size * 0.46, ring = size * 0.30, ringW = size * 0.085;
  return png(size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    const edge = Math.max(0, Math.min(1, R - d + 0.5));       // antialias at the rim
    if (edge <= 0) return [0, 0, 0, 0];
    const onRing = Math.max(0, 1 - Math.abs(d - ring) / ringW);
    const col = onRing > 0.5 ? DARK : GOLD;
    return [col[0], col[1], col[2], Math.round(255 * edge)];
  });
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const s of [16, 48, 128]) {
  writeFileSync(new URL(`../icons/icon${s}.png`, import.meta.url), disc(s));
  console.log('icon' + s + '.png written');
}
