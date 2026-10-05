#!/usr/bin/env node
// Headless check: run a ROM for N frames and write the color frame plus an
// object-layer visualization to PNG.
//
//   node tools/render-frame.mjs roms/demo.bin [frames=120] [out=out/frame]
//   Optional env: HOLD="right,fire" to hold joystick inputs the whole time.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Atari2600 } from '../src/emu/atari.js';
import { NTSC_PALETTE } from '../src/emu/palette.js';
import { WIDTH, OBJ_PF, OBJ_BL, OBJ_M0, OBJ_M1, OBJ_P0, OBJ_P1 } from '../src/emu/tia.js';

const [romPath, framesArg = '120', outArg = 'out/frame'] = process.argv.slice(2);
if (!romPath) { console.error('usage: render-frame.mjs <rom> [frames] [outPrefix]'); process.exit(1); }

const atari = new Atari2600();
const scheme = atari.load(fs.readFileSync(romPath));
const hold = (process.env.HOLD || '').split(',').filter(Boolean);
const dirBits = { up: 0x10, down: 0x20, left: 0x40, right: 0x80 };
for (const h of hold) {
  if (dirBits[h]) atari.riot.input.swcha &= ~dirBits[h];
  if (h === 'fire') atari.tia.input.fire0 = true;
}

const t0 = performance.now();
const frames = parseInt(framesArg, 10);
const lineCounts = [];
for (let i = 0; i < frames; i++) { atari.runFrame(); lineCounts.push(atari.tia.front.lines); }
const ms = performance.now() - t0;
const f = atari.tia.front;

console.log(`mapper=${scheme} frames=${frames} ${(ms / frames).toFixed(2)}ms/frame`);
console.log(`lines/frame (last 5): ${lineCounts.slice(-5).join(' ')}  visible ${f.firstVisible}..${f.lastVisible}`);
console.log(`pc=$${atari.cpu.pc.toString(16)} jammed=${atari.cpu.jammed}`);

function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Scale 3x horizontally, 2x vertically, roughly matching TV aspect.
const top = f.firstVisible, h = Math.max(1, f.lastVisible - top + 1);
const SX = 3, SY = 2, W = WIDTH * SX, H = h * SY;
const color = Buffer.alloc(W * H * 3), layers = Buffer.alloc(W * H * 3);
const layerRGB = (m) => {
  if (m & OBJ_P0) return [255, 230, 60];
  if (m & OBJ_P1) return [80, 200, 255];
  if (m & OBJ_M0) return [255, 120, 0];
  if (m & OBJ_M1) return [0, 120, 255];
  if (m & OBJ_BL) return [255, 255, 255];
  if (m & OBJ_PF) return [200, 60, 200];
  return [20, 20, 20];
};
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (top + (y / SY | 0)) * WIDTH + (x / SX | 0);
    const c = NTSC_PALETTE[f.color[i]];
    const o = (y * W + x) * 3;
    color[o] = c >> 16; color[o + 1] = (c >> 8) & 255; color[o + 2] = c & 255;
    const l = layerRGB(f.mask[i]);
    layers[o] = l[0]; layers[o + 1] = l[1]; layers[o + 2] = l[2];
  }
}
fs.mkdirSync(path.dirname(outArg), { recursive: true });
fs.writeFileSync(`${outArg}.png`, png(W, H, color));
fs.writeFileSync(`${outArg}-layers.png`, png(W, H, layers));
console.log(`wrote ${outArg}.png and ${outArg}-layers.png`);
