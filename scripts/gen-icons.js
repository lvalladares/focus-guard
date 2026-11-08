import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const TOP = [67, 56, 202];
const BOTTOM = [8, 145, 178];
const WHITE = [238, 244, 255];

function subpixel(x, y, dim) {
  const radius = dim * 0.22;
  const cx = Math.min(x, dim - 1 - x);
  const cy = Math.min(y, dim - 1 - y);
  if (cx >= radius || cy >= radius) return true;
  const dx = radius - cx;
  const dy = radius - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function sample(x, y, dim) {
  if (!subpixel(x, y, dim)) return null;
  const t = y / (dim - 1);
  const base = [
    lerp(TOP[0], BOTTOM[0], t),
    lerp(TOP[1], BOTTOM[1], t),
    lerp(TOP[2], BOTTOM[2], t),
  ];
  const dx = x - dim / 2 + 0.5;
  const dy = y - dim / 2 + 0.5;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ringR = dim * 0.3;
  const ringW = dim * 0.055;
  const dotR = dim * 0.12;
  const onRing = Math.abs(dist - ringR) <= ringW / 2;
  const onDot = dist <= dotR;
  if (onRing || onDot) return WHITE;
  return base;
}

function renderIcon(size) {
  const dim = size * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px * SUPERSAMPLE + sx + 0.5;
          const y = py * SUPERSAMPLE + sy + 0.5;
          const color = sample(x, y, dim);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const count = SUPERSAMPLE * SUPERSAMPLE;
      const idx = (py * size + px) * 4;
      pixels[idx] = a > 0 ? Math.round(r / (a / 255)) : 0;
      pixels[idx + 1] = a > 0 ? Math.round(g / (a / 255)) : 0;
      pixels[idx + 2] = a > 0 ? Math.round(b / (a / 255)) : 0;
      pixels[idx + 3] = Math.round(a / count);
    }
  }
  return encodePng(size, size, pixels);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'assets', 'icons');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

for (const size of SIZES) {
  const png = renderIcon(size);
  const outPath = join(outDir, `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
