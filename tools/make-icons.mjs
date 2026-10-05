#!/usr/bin/env node
// Generate the home-screen icons: the demo cart's little runner, in
// chunky pixels on the app's dark background.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SPRITE = ['00111100', '00111100', '00011000', '01111110', '00111100', '00111100', '00100100', '01100110'];
const BG = [11, 13, 20], FG = [255, 138, 42], SHADE = [201, 95, 16];

function png(size) {
  const cell = Math.floor(size / 12), ox = Math.floor((size - cell * 8) / 2), oy = ox;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - ox) / cell), cy = Math.floor((y - oy) / cell);
      let c = BG;
      if (cx >= 0 && cx < 8 && cy >= 0 && cy < 8 && SPRITE[cy][cx] === '1') {
        // Shade the lower-right edge of each block for a hint of depth.
        const lx = (x - ox) % cell, ly = (y - oy) % cell;
        c = (lx > cell * 0.78 || ly > cell * 0.78) ? SHADE : FG;
      }
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [180, 512]) fs.writeFileSync(`icon-${size}.png`, png(size));
console.log('wrote icon-180.png, icon-512.png');
