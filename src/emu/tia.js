// TIA (Television Interface Adaptor) — video, collisions, input ports, and
// the hook for audio.
//
// Besides the usual color framebuffer, every pixel records which objects were
// present (`mask`) and the color each layer had at that moment (`cBK`, `cPF`,
// `cP0`, `cP1`). That per-object breakdown is what the 3D renderer extrudes.

import { TIAAudio } from './audio.js';
import { capture, apply } from './state.js';

export const OBJ_PF = 1, OBJ_BL = 2, OBJ_M0 = 4, OBJ_M1 = 8, OBJ_P0 = 16, OBJ_P1 = 32;
// Not an object: set on pixels drawn while CTRLPF playfield priority was on.
export const OBJ_PFP = 64;

export const WIDTH = 160;
export const MAX_LINES = 320;
const HBLANK = 68;
const LINE_CLOCKS = 228;

// Copy offsets for player/missile NUSIZ modes 0..7 (5 and 7 are stretched).
const COPIES = [[0], [0, 16], [0, 32], [0, 16, 32], [0, 64], [0], [0, 32, 64], [0]];

// Collision latch bit layout: register i (0..7) uses bits 2i+1 (D7) and 2i (D6).
const COLLISION_TABLE = new Uint16Array(64);
(() => {
  const pairs = [
    // [reg, bit(1=D7,0=D6), objA, objB]
    [0, 1, OBJ_M0, OBJ_P1], [0, 0, OBJ_M0, OBJ_P0],
    [1, 1, OBJ_M1, OBJ_P0], [1, 0, OBJ_M1, OBJ_P1],
    [2, 1, OBJ_P0, OBJ_PF], [2, 0, OBJ_P0, OBJ_BL],
    [3, 1, OBJ_P1, OBJ_PF], [3, 0, OBJ_P1, OBJ_BL],
    [4, 1, OBJ_M0, OBJ_PF], [4, 0, OBJ_M0, OBJ_BL],
    [5, 1, OBJ_M1, OBJ_PF], [5, 0, OBJ_M1, OBJ_BL],
    [6, 1, OBJ_BL, OBJ_PF],
    [7, 1, OBJ_P0, OBJ_P1], [7, 0, OBJ_M0, OBJ_M1],
  ];
  for (let m = 0; m < 64; m++) {
    let c = 0;
    for (const [reg, bit, a, b] of pairs) if ((m & a) && (m & b)) c |= 1 << (reg * 2 + bit);
    COLLISION_TABLE[m] = c;
  }
})();

function makeFrame() {
  const n = WIDTH * MAX_LINES;
  return {
    color: new Uint8Array(n),  // displayed palette index
    mask: new Uint8Array(n),   // OBJ_* bits present at the pixel
    cBK: new Uint8Array(n),    // background color
    cPF: new Uint8Array(n),    // playfield/ball color (score mode applied)
    cP0: new Uint8Array(n),    // player0/missile0 color
    cP1: new Uint8Array(n),    // player1/missile1 color
    lineVisible: new Uint8Array(MAX_LINES),
    lines: 0,
    firstVisible: 0,
    lastVisible: 0,
    number: 0,
  };
}

const TIA_STATE = ['cc', 'hpos', 'line', 'vsync', 'vblank', 'nusiz0', 'nusiz1', 'colup0', 'colup1', 'colupf', 'colubk', 'ctrlpf', 'refp0', 'refp1', 'pf0', 'pf1', 'pf2', 'pfBits', 'pos', 'hm', 'grp0', 'grp0old', 'grp1', 'grp1old', 'enam0', 'enam1', 'enabl', 'enablOld', 'vdelp0', 'vdelp1', 'vdelbl', 'resmp0', 'resmp1', 'collisions', 'hmoveBar', 'paddleDumpCycle', 'paddleDumped', 'wsync', 'frameNumber', 'audio'];
export class TIA {
  saveState() { return capture(this, TIA_STATE); }
  loadState(s) { apply(this, TIA_STATE, s); }

  constructor() {
    this.audio = new TIAAudio();
    this.back = makeFrame();
    this.front = makeFrame();
    this.frameNumber = 0;
    this.onFrame = null;   // callback(frame)
    this.input = {
      fire0: false, fire1: false,
      paddles: [0.5, 0.5, 0.5, 0.5],
      paddleFire: [false, false, false, false],
      paddleMode: false,
    };
    this.reset();
  }

  reset() {
    this.cc = 0; this.hpos = 0; this.line = 0;
    this.vsync = 0; this.vblank = 0;
    this.nusiz0 = 0; this.nusiz1 = 0;
    this.colup0 = 0; this.colup1 = 0; this.colupf = 0; this.colubk = 0;
    this.ctrlpf = 0; this.refp0 = 0; this.refp1 = 0;
    this.pf0 = 0; this.pf1 = 0; this.pf2 = 0;
    this.pfBits = new Uint8Array(20);
    this.pos = new Int32Array(5);  // P0, P1, M0, M1, BL
    this.hm = new Int32Array(5);
    this.grp0 = 0; this.grp0old = 0; this.grp1 = 0; this.grp1old = 0;
    this.enam0 = 0; this.enam1 = 0; this.enabl = 0; this.enablOld = 0;
    this.vdelp0 = 0; this.vdelp1 = 0; this.vdelbl = 0;
    this.resmp0 = 0; this.resmp1 = 0;
    this.collisions = 0;
    this.hmoveBar = false;
    this.paddleDumpCycle = 0;
    this.paddleDumped = false;
    this.audio.reset();
  }

  updatePF() {
    const b = this.pfBits;
    for (let i = 0; i < 4; i++) b[i] = (this.pf0 >> (4 + i)) & 1;
    for (let i = 0; i < 8; i++) b[4 + i] = (this.pf1 >> (7 - i)) & 1;
    for (let i = 0; i < 8; i++) b[12 + i] = (this.pf2 >> i) & 1;
  }

  // Advance the beam up to (but not including) color clock `target`.
  catchUp(target) {
    while (this.cc < target) {
      const hpos = this.hpos;
      if (hpos >= HBLANK) this.renderPixel(hpos - HBLANK);
      else if (hpos === 0) this.audio.sample();
      if (hpos === 114) this.audio.sample();
      this.cc++;
      if (++this.hpos === LINE_CLOCKS) {
        this.hpos = 0;
        this.hmoveBar = false;
        if (++this.line >= MAX_LINES) this.endFrame();
      }
    }
  }

  renderPixel(x) {
    const f = this.back;
    const idx = this.line * WIDTH + x;
    const bk = this.colubk;
    if ((this.vblank & 2) || (this.hmoveBar && x < 8)) {
      f.color[idx] = 0; f.mask[idx] = 0; f.cBK[idx] = (this.vblank & 2) ? 0 : bk;
      return;
    }
    f.lineVisible[this.line] = 1;

    // Playfield
    const pfx = x >> 2;
    let pf;
    if (pfx < 20) pf = this.pfBits[pfx];
    else pf = this.pfBits[(this.ctrlpf & 1) ? 39 - pfx : pfx - 20];

    let mask = pf ? OBJ_PF : 0;
    const pos = this.pos;

    // Ball
    if (this.vdelbl ? this.enablOld : this.enabl) {
      let d = x - pos[4]; if (d < 0) d += WIDTH;
      if (d < (1 << ((this.ctrlpf >> 4) & 3))) mask |= OBJ_BL;
    }
    // Missiles
    if (this.enam0 && !this.resmp0 && this.missileHit(x, pos[2], this.nusiz0)) mask |= OBJ_M0;
    if (this.enam1 && !this.resmp1 && this.missileHit(x, pos[3], this.nusiz1)) mask |= OBJ_M1;
    // Players
    const g0 = this.vdelp0 ? this.grp0old : this.grp0;
    if (g0 && this.playerHit(x, pos[0], g0, this.refp0, this.nusiz0)) mask |= OBJ_P0;
    const g1 = this.vdelp1 ? this.grp1old : this.grp1;
    if (g1 && this.playerHit(x, pos[1], g1, this.refp1, this.nusiz1)) mask |= OBJ_P1;

    this.collisions |= COLLISION_TABLE[mask];

    const c0 = this.colup0, c1 = this.colup1;
    let cpf = this.colupf;
    const pfp = this.ctrlpf & 4;
    if ((this.ctrlpf & 2) && !pfp && (mask & OBJ_PF)) cpf = x < 80 ? c0 : c1;

    let color;
    if (pfp) {
      if (mask & (OBJ_PF | OBJ_BL)) color = cpf;
      else if (mask & (OBJ_P0 | OBJ_M0)) color = c0;
      else if (mask & (OBJ_P1 | OBJ_M1)) color = c1;
      else color = bk;
    } else {
      if (mask & (OBJ_P0 | OBJ_M0)) color = c0;
      else if (mask & (OBJ_P1 | OBJ_M1)) color = c1;
      else if (mask & (OBJ_PF | OBJ_BL)) color = cpf;
      else color = bk;
    }

    f.color[idx] = color;
    f.mask[idx] = pfp ? mask | OBJ_PFP : mask;
    f.cBK[idx] = bk;
    f.cPF[idx] = cpf;
    f.cP0[idx] = c0;
    f.cP1[idx] = c1;
  }

  missileHit(x, p, nusiz) {
    let d = x - p; if (d < 0) d += WIDTH;
    const w = 1 << ((nusiz >> 4) & 3);
    const copies = COPIES[nusiz & 7];
    for (let i = 0; i < copies.length; i++) {
      const o = d - copies[i];
      if (o >= 0 && o < w) return true;
    }
    return false;
  }

  playerHit(x, p, g, refl, nusiz) {
    let d = x - p; if (d < 0) d += WIDTH;
    const mode = nusiz & 7;
    let bit;
    if (mode === 5) {
      d -= 1; if (d < 0 || d >= 16) return false;
      bit = d >> 1;
    } else if (mode === 7) {
      d -= 1; if (d < 0 || d >= 32) return false;
      bit = d >> 2;
    } else {
      const copies = COPIES[mode];
      bit = -1;
      for (let i = 0; i < copies.length; i++) {
        const o = d - copies[i];
        if (o >= 0 && o < 8) { bit = o; break; }
      }
      if (bit < 0) return false;
    }
    return refl ? (g >> bit) & 1 : (g >> (7 - bit)) & 1;
  }

  endFrame() {
    const f = this.back;
    f.lines = this.line;
    let first = -1, last = -1;
    for (let i = 0; i < Math.min(this.line, MAX_LINES); i++) {
      if (f.lineVisible[i]) { if (first < 0) first = i; last = i; }
    }
    f.firstVisible = first < 0 ? 0 : first;
    f.lastVisible = last < 0 ? 0 : last;
    f.number = ++this.frameNumber;
    this.back = this.front;
    this.front = f;
    this.back.lineVisible.fill(0);
    this.line = 0;
    if (this.onFrame) this.onFrame(f);
  }

  read(addr, cycle) {
    this.catchUp(cycle * 3 + 3);
    const a = addr & 0x0F;
    if (a < 8) return ((this.collisions >> (a * 2)) & 3) << 6;
    const inp = this.input;
    switch (a) {
      case 0x8: case 0x9: case 0xA: case 0xB: {
        if (this.paddleDumped) return 0;
        const threshold = 380 + inp.paddles[a - 8] * 76 * 190;
        return (cycle - this.paddleDumpCycle) > threshold ? 0x80 : 0;
      }
      case 0xC: return (inp.fire0 || (inp.paddleMode && inp.paddleFire[0])) ? 0 : 0x80;
      case 0xD: return (inp.fire1 || (inp.paddleMode && inp.paddleFire[2])) ? 0 : 0x80;
    }
    return 0;
  }

  write(addr, v, cycle) {
    this.catchUp(cycle * 3 + 3);
    const pos = this.pos;
    switch (addr & 0x3F) {
      case 0x00: // VSYNC
        if ((v & 2) && !(this.vsync & 2) && this.line > 10) this.endFrame();
        this.vsync = v;
        break;
      case 0x01: // VBLANK
        if (v & 0x80) this.paddleDumped = true;
        else if (this.paddleDumped) { this.paddleDumped = false; this.paddleDumpCycle = cycle; }
        this.vblank = v;
        break;
      case 0x02: this.wsync = true; break;
      case 0x03: break; // RSYNC
      case 0x04: this.nusiz0 = v; break;
      case 0x05: this.nusiz1 = v; break;
      case 0x06: this.colup0 = v >> 1; break;
      case 0x07: this.colup1 = v >> 1; break;
      case 0x08: this.colupf = v >> 1; break;
      case 0x09: this.colubk = v >> 1; break;
      case 0x0A: this.ctrlpf = v; break;
      case 0x0B: this.refp0 = v & 8; break;
      case 0x0C: this.refp1 = v & 8; break;
      case 0x0D: this.pf0 = v; this.updatePF(); break;
      case 0x0E: this.pf1 = v; this.updatePF(); break;
      case 0x0F: this.pf2 = v; this.updatePF(); break;
      case 0x10: pos[0] = this.hpos < HBLANK ? 3 : (this.hpos - HBLANK + 5) % WIDTH; break;
      case 0x11: pos[1] = this.hpos < HBLANK ? 3 : (this.hpos - HBLANK + 5) % WIDTH; break;
      case 0x12: pos[2] = this.hpos < HBLANK ? 2 : (this.hpos - HBLANK + 4) % WIDTH; break;
      case 0x13: pos[3] = this.hpos < HBLANK ? 2 : (this.hpos - HBLANK + 4) % WIDTH; break;
      case 0x14: pos[4] = this.hpos < HBLANK ? 2 : (this.hpos - HBLANK + 4) % WIDTH; break;
      case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1A:
        this.audio.write(addr & 0x3F, v);
        break;
      case 0x1B: this.grp0 = v; this.grp1old = this.grp1; break;
      case 0x1C: this.grp1 = v; this.grp0old = this.grp0; this.enablOld = this.enabl; break;
      case 0x1D: this.enam0 = v & 2; break;
      case 0x1E: this.enam1 = v & 2; break;
      case 0x1F: this.enabl = v & 2; break;
      case 0x20: this.hm[0] = (v << 24) >> 28; break;
      case 0x21: this.hm[1] = (v << 24) >> 28; break;
      case 0x22: this.hm[2] = (v << 24) >> 28; break;
      case 0x23: this.hm[3] = (v << 24) >> 28; break;
      case 0x24: this.hm[4] = (v << 24) >> 28; break;
      case 0x25: this.vdelp0 = v & 1; break;
      case 0x26: this.vdelp1 = v & 1; break;
      case 0x27: this.vdelbl = v & 1; break;
      case 0x28:
        if (this.resmp0 && !(v & 2)) pos[2] = (pos[0] + this.missileCenter(this.nusiz0)) % WIDTH;
        this.resmp0 = v & 2;
        break;
      case 0x29:
        if (this.resmp1 && !(v & 2)) pos[3] = (pos[1] + this.missileCenter(this.nusiz1)) % WIDTH;
        this.resmp1 = v & 2;
        break;
      case 0x2A: // HMOVE
        for (let i = 0; i < 5; i++) pos[i] = ((pos[i] - this.hm[i]) % WIDTH + WIDTH) % WIDTH;
        if (this.hpos < HBLANK) this.hmoveBar = true;
        break;
      case 0x2B: this.hm.fill(0); break; // HMCLR
      case 0x2C: this.collisions = 0; break; // CXCLR
    }
  }

  missileCenter(nusiz) {
    const m = nusiz & 7;
    return m === 5 ? 6 : m === 7 ? 10 : 3;
  }
}
