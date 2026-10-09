// Draws the extension icons (rounded violet square + white bookmark with a play
// notch) straight into PNG files, so no image tools are needed.
// Usage: node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Coverage of the shape at a point in unit space (0..1), sampled 4x4 per pixel.
function inRoundedSquare(u, v, r) {
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  return dx * dx + dy * dy <= r * r;
}
function inBookmark(u, v) {
  // Ribbon from (0.3,0.2) to (0.7,0.82) with a V cut at the bottom.
  if (u < 0.3 || u > 0.7 || v < 0.2 || v > 0.82) return false;
  const cut = 0.82 - 0.16 * (1 - Math.abs(u - 0.5) / 0.2);
  if (v > cut) return false;
  // Play triangle punched out of the ribbon.
  const tu = (u - 0.43) / 0.17;
  const tv = (v - 0.32) / 0.24;
  if (tu >= 0 && tu <= 1 && tv >= tu / 2 && tv <= 1 - tu / 2) return false;
  return true;
}

function draw(size) {
  const S = 4;
  return png(size, (x, y) => {
    let bg = 0;
    let fg = 0;
    for (let i = 0; i < S; i++) {
      for (let j = 0; j < S; j++) {
        const u = (x + (i + 0.5) / S) / size;
        const v = (y + (j + 0.5) / S) / size;
        if (inRoundedSquare(u, v, 0.22)) {
          bg++;
          if (inBookmark(u, v)) fg++;
        }
      }
    }
    const a = bg / (S * S);
    const f = bg ? fg / bg : 0;
    // Diagonal violet gradient.
    const t = (x + y) / (2 * size);
    const base = [139 - 30 * t, 92 - 34 * t, 246 - 10 * t];
    const c = base.map((ch) => Math.round(ch + (255 - ch) * f));
    return [...c, Math.round(a * 255)];
  });
}

fs.mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(OUT, `icon${s}.png`), draw(s));
console.log('icons written to', OUT);
