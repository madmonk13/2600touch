// Works out whether a cart is played with paddles, off the main thread.
//
// The cart is run twice from an identical power-on state (seeded randomness),
// once with every paddle turned fully one way and once fully the other, pressing
// Reset and then the paddle buttons along the way (some games only start from a
// paddle button). If the two runs' RAM ever differs, the game is reading the
// paddles and acting on them. Joystick games give identical runs.

import { Atari2600 } from './emu/atari.js';

const MAX_FRAMES = 240;    // 4 s of game time
const CHECK_EVERY = 10;    // frames between RAM comparisons
const PADDLE_BUTTONS = 0x80 | 0x40 | 0x08 | 0x04;

function seeded(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
}

function boot(bytes, pot) {
  const random = Math.random;
  Math.random = seeded(7);
  const atari = new Atari2600();
  atari.load(bytes);
  Math.random = random;
  atari.tia.input.paddles.fill(pot);
  return atari;
}

function detect(bytes) {
  const a = boot(bytes, 0.05), b = boot(bytes, 0.95);
  // Count reads of each paddle input, to know which paddle the game uses.
  const reads = [0, 0, 0, 0];
  const read = a.tia.read.bind(a.tia);
  a.tia.read = (addr, cycle) => {
    const r = addr & 0x0F;
    if (r >= 8 && r <= 0x0B) reads[r - 8]++;
    return read(addr, cycle);
  };
  for (let i = 0; i < MAX_FRAMES; i++) {
    for (const atari of [a, b]) {
      atari.riot.input.reset = i >= 60 && i < 70;
      atari.riot.input.swcha = i >= 90 && i < 100 ? 0xFF & ~PADDLE_BUTTONS : 0xFF;
      atari.runFrame();
    }
    if (i % CHECK_EVERY === CHECK_EVERY - 1 && !sameRam(a, b)) {
      // Favor the first paddle unless the game clearly reads another one.
      const most = Math.max(...reads);
      const index = reads[0] * 4 >= most ? 0 : reads.indexOf(most);
      return { paddle: true, index };
    }
  }
  return { paddle: false };
}

function sameRam(a, b) {
  const x = a.riot.ram, y = b.riot.ram;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

self.onmessage = ({ data: { id, bytes } }) => {
  let result;
  try { result = detect(bytes); } catch { result = { paddle: false }; }
  self.postMessage({ id, ...result });
};
