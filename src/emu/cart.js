// Cartridge mappers. Each takes the ROM image and exposes
//   read(addr), write(addr, v)  — addr is in the 4K cart window ($1000-$1FFF)
//   snoop(addr, v)              — optional: sees writes below $1000 (used by 3F)

import { capture, apply } from './state.js';

function hasSig(rom, sig, minCount = 1) {
  let count = 0;
  outer: for (let i = 0; i <= rom.length - sig.length; i++) {
    for (let j = 0; j < sig.length; j++) if (rom[i + j] !== sig[j]) continue outer;
    if (++count >= minCount) return true;
  }
  return false;
}

function isSuperchip(rom) {
  // Superchip carts leave the first 256 bytes of each bank as filler where the RAM sits.
  for (let bank = 0; bank < rom.length; bank += 4096) {
    const b = rom[bank];
    for (let i = 1; i < 256; i++) if (rom[bank + i] !== b) return false;
  }
  return true;
}

const FLAT_STATE = [];
class Flat {
  saveState() { return capture(this, FLAT_STATE); }
  loadState(s) { apply(this, FLAT_STATE, s); }

  constructor(rom) { this.rom = rom; this.mask = rom.length - 1; this.name = rom.length === 2048 ? '2K' : '4K'; }
  read(a) { return this.rom[a & this.mask]; }
  write() {}
}

// F8 / F6 / F4 / FA style: hotspots near the top of the address space pick a 4K bank.
const HOTSPOT_STATE = ['bank', 'ram'];
class Hotspot {
  saveState() { return capture(this, HOTSPOT_STATE); }
  loadState(s) { apply(this, HOTSPOT_STATE, s); }

  constructor(rom, first, count, name, ramSize = 0) {
    this.rom = rom; this.first = first; this.count = count; this.name = name;
    this.bank = count - 1;
    this.ramSize = ramSize;
    if (ramSize) this.ram = new Uint8Array(ramSize);
  }
  hit(a) {
    const o = (a & 0x0FFF) - this.first;
    if (o >= 0 && o < this.count) this.bank = o;
  }
  read(a) {
    const off = a & 0x0FFF;
    if (this.ram && off >= this.ramSize && off < this.ramSize * 2) return this.ram[off - this.ramSize];
    this.hit(a);
    return this.rom[this.bank * 4096 + off];
  }
  write(a, v) {
    const off = a & 0x0FFF;
    if (this.ram && off < this.ramSize) { this.ram[off] = v; return; }
    this.hit(a);
  }
}

// Parker Brothers E0: four 1K slices, the last fixed to the final 1K.
const E0_STATE = ['slice'];
class E0 {
  saveState() { return capture(this, E0_STATE); }
  loadState(s) { apply(this, E0_STATE, s); }

  constructor(rom) { this.rom = rom; this.name = 'E0'; this.slice = [4, 5, 6, 7]; }
  hit(a) {
    const off = a & 0x0FFF;
    if (off >= 0xFE0 && off < 0xFF8) this.slice[(off - 0xFE0) >> 3] = off & 7;
  }
  read(a) {
    this.hit(a);
    const off = a & 0x0FFF;
    return this.rom[this.slice[off >> 10] * 1024 + (off & 0x3FF)];
  }
  write(a) { this.hit(a); }
}

// Tigervision 3F: writes to $00-$3F select the 2K bank at $1000; $1800 is fixed to the last 2K.
const T3F_STATE = ['bank'];
class T3F {
  saveState() { return capture(this, T3F_STATE); }
  loadState(s) { apply(this, T3F_STATE, s); }
  constructor(rom) { this.rom = rom; this.name = '3F'; this.bank = 0; this.banks = rom.length >> 11; }
  read(a) {
    const off = a & 0x0FFF;
    if (off < 0x800) return this.rom[(this.bank % this.banks) * 2048 + off];
    return this.rom[this.rom.length - 2048 + (off & 0x7FF)];
  }
  write() {}
  snoop(a, v) { if ((a & 0x1FFF) <= 0x3F) this.bank = v; }
}

// M-Network E7: switchable 2K ROM/RAM at $1000, 256-byte RAM banks at $1800, fixed ROM above.
const E7_STATE = ['bank', 'ramBank', 'ram1k', 'ram256'];
class E7 {
  saveState() { return capture(this, E7_STATE); }
  loadState(s) { apply(this, E7_STATE, s); }

  constructor(rom) {
    this.rom = rom; this.name = 'E7';
    this.romBanks = rom.length >> 11;
    this.ram1k = new Uint8Array(1024);
    this.ram256 = new Uint8Array(1024);
    this.bank = 0; this.ramBank = 0;
  }
  hit(a) {
    const off = a & 0x0FFF;
    if (off >= 0xFE0 && off <= 0xFE7) this.bank = off & 7;
    else if (off >= 0xFE8 && off <= 0xFEB) this.ramBank = off & 3;
  }
  read(a) {
    this.hit(a);
    const off = a & 0x0FFF;
    if (off < 0x800) {
      if (this.bank === 7) return off >= 0x400 ? this.ram1k[off & 0x3FF] : 0;
      return this.rom[(this.bank % this.romBanks) * 2048 + off];
    }
    if (off < 0x900) return 0;
    if (off < 0xA00) return this.ram256[this.ramBank * 256 + (off & 0xFF)];
    return this.rom[this.rom.length - 2048 + (off & 0x7FF)];
  }
  write(a, v) {
    this.hit(a);
    const off = a & 0x0FFF;
    if (off < 0x400 && this.bank === 7) this.ram1k[off] = v;
    else if (off >= 0x800 && off < 0x900) this.ram256[this.ramBank * 256 + (off & 0xFF)] = v;
  }
}

// Activision FE (Decathlon, Robot Tank, Space Shuttle): no hotspots. The
// cart watches the stack: after an access to $01FE (JSR pushing, RTS pulling
// the return address), the next byte on the bus is the new PC's high byte,
// and its bit 5 picks the bank ($Fxxx code or $Dxxx code).
const FE_STATE = ['bank', 'armed'];
class FE {
  saveState() { return capture(this, FE_STATE); }
  loadState(s) { apply(this, FE_STATE, s); }

  constructor(rom) {
    this.rom = rom; this.name = 'FE';
    // Which half holds the $Fxxx code: the one whose reset vector says so
    // (when the two halves disagree), else the first.
    const hi = (b) => rom[b * 4096 + 0xFFD] & 0x20;
    this.fBank = hi(0) || !hi(1) ? 0 : 1;
    this.bank = this.fBank; this.armed = false;
  }
  access(a, v) {
    if (this.armed) { this.armed = false; this.bank = v & 0x20 ? this.fBank : 1 - this.fBank; }
    if (a === 0x01FE) this.armed = true;
  }
  read(a) { return this.rom[this.bank * 4096 + (a & 0x0FFF)]; }
  write() {}
}

// UA Limited (8K): any access to $0220 selects bank 0, $0240 bank 1.
// Econobank 0840 (8K): the same at $0800 and $0840.
const BUS_HOTSPOT_STATE = ['bank'];
class BusHotspot {
  saveState() { return capture(this, BUS_HOTSPOT_STATE); }
  loadState(s) { apply(this, BUS_HOTSPOT_STATE, s); }

  constructor(rom, name, mask, lo, hi) { this.rom = rom; this.name = name; this.mask = mask; this.lo = lo; this.hi = hi; this.bank = 0; }
  access(a) {
    const m = a & this.mask;
    if (m === this.lo) this.bank = 0; else if (m === this.hi) this.bank = 1;
  }
  read(a) { return this.rom[this.bank * 4096 + (a & 0x0FFF)]; }
  write() {}
}

// CommaVid (Magicard, Video Life): 2K ROM at $1800 plus 1K of RAM, read at
// $1000-$13FF and written at $1400-$17FF. A 4K image carries the RAM's
// starting contents in its first 1K.
const CV_STATE = ['ram'];
class CV {
  saveState() { return capture(this, CV_STATE); }
  loadState(s) { apply(this, CV_STATE, s); }

  constructor(rom) {
    this.name = 'CV';
    this.rom = rom.subarray(rom.length - 2048);
    this.ram = new Uint8Array(1024);
    if (rom.length === 4096) this.ram.set(rom.subarray(0, 1024));
  }
  read(a) {
    const off = a & 0x0FFF;
    if (off < 0x400) return this.ram[off];
    if (off < 0x800) return 0;
    return this.rom[off & 0x7FF];
  }
  write(a, v) {
    const off = a & 0x0FFF;
    if (off >= 0x400 && off < 0x800) this.ram[off & 0x3FF] = v;
  }
}

// Dynacom F0 (Megaboy, 64K): each access to $1FF0 steps to the next 4K bank.
const F0_STATE = ['bank'];
class F0 {
  saveState() { return capture(this, F0_STATE); }
  loadState(s) { apply(this, F0_STATE, s); }

  constructor(rom) { this.rom = rom; this.name = 'F0'; this.banks = rom.length >> 12; this.bank = this.banks - 1; }
  hit(a) { if ((a & 0x0FFF) === 0xFF0) this.bank = (this.bank + 1) % this.banks; }
  read(a) { this.hit(a); return this.rom[this.bank * 4096 + (a & 0x0FFF)]; }
  write(a) { this.hit(a); }
}

// SB "Superbanking" (128K/256K homebrew): an access to $0800-$0FFF picks the
// 4K bank from the address's low bits.
const SB_STATE = ['bank'];
class SB {
  saveState() { return capture(this, SB_STATE); }
  loadState(s) { apply(this, SB_STATE, s); }

  constructor(rom) { this.rom = rom; this.name = 'SB'; this.banks = rom.length >> 12; this.bank = this.banks - 1; }
  access(a) { if ((a & 0x1800) === 0x0800) this.bank = a & (this.banks - 1); }
  read(a) { return this.rom[this.bank * 4096 + (a & 0x0FFF)]; }
  write() {}
}

// Tigervision 3E (homebrew): 3F plus 32K of RAM. A write to $3F maps a 2K ROM
// bank at $1000; a write to $3E maps a 1K RAM bank there instead (read at
// $1000-$13FF, written at $1400-$17FF). $1800 is fixed to the last 2K.
const T3E_STATE = ['bank', 'ramBank', 'ram'];
class T3E {
  saveState() { return capture(this, T3E_STATE); }
  loadState(s) { apply(this, T3E_STATE, s); }

  constructor(rom) { this.rom = rom; this.name = '3E'; this.banks = rom.length >> 11; this.bank = 0; this.ramBank = -1; this.ram = new Uint8Array(32768); }
  read(a) {
    const off = a & 0x0FFF;
    if (off >= 0x800) return this.rom[this.rom.length - 2048 + (off & 0x7FF)];
    if (this.ramBank >= 0) return off < 0x400 ? this.ram[this.ramBank * 1024 + off] : 0;
    return this.rom[(this.bank % this.banks) * 2048 + off];
  }
  write(a, v) {
    const off = a & 0x0FFF;
    if (this.ramBank >= 0 && off >= 0x400 && off < 0x800) this.ram[this.ramBank * 1024 + (off & 0x3FF)] = v;
  }
  snoop(a, v) {
    const z = a & 0x1FFF;
    if (z === 0x3F) { this.bank = v; this.ramBank = -1; } else if (z === 0x3E) this.ramBank = v & 31;
  }
}

// Pitfall II's DPC chip (David Crane's display processor): two 4K program
// banks (hotspots $1FF8/$1FF9), 2K of graphics read through eight "data
// fetchers", a random number generator, and three fetchers that can run as
// square-wave oscillators mixed into a 4-bit music level.
//   read  $1000-$1003 random number, $1004-$1007 music level,
//         $1008+8f+n fetcher n: data, data & flag, nybbles swapped, bits
//         reversed, rotated right, rotated left, or its flag (f = 1..7)
//   write $1040+8f+n: top, bottom, counter low, counter high (+ music mode
//         for fetchers 5-7), and f = 6 resets the random number generator.
const DPC_CLOCK = 20000, CPU_HZ = 1193182;
const DPC_STATE = ['bank', 'tops', 'bottoms', 'counters', 'flags', 'music', 'random', 'lastCycle', 'clockFrac'];
class DPC {
  saveState() { return capture(this, DPC_STATE); }
  loadState(s) { apply(this, DPC_STATE, s); }

  constructor(rom) {
    this.name = 'DPC';
    this.rom = rom.subarray(0, 8192);
    this.gfx = rom.subarray(8192, 10240);
    this.bank = 1;
    this.tops = new Uint8Array(8); this.bottoms = new Uint8Array(8);
    this.counters = new Uint16Array(8); this.flags = new Uint8Array(8);
    this.music = new Uint8Array(3);
    this.random = 1;
    this.lastCycle = 0; this.clockFrac = 0;
  }
  attach(console) { this.console = console; }

  // Run the music oscillators up to now: each clock steps a fetcher's low
  // counter down through top..0; the flag is high while it's above bottom.
  updateMusic() {
    const now = this.console ? this.console.cpu.cycles : 0;
    this.clockFrac += (now - this.lastCycle) * DPC_CLOCK / CPU_HZ;
    this.lastCycle = now;
    const clocks = Math.floor(this.clockFrac);
    this.clockFrac -= clocks;
    if (!clocks) return;
    for (let i = 5; i < 8; i++) {
      if (!this.music[i - 5]) continue;
      const top = this.tops[i];
      let low = this.counters[i] & 0xFF;
      if (top) { low -= clocks % (top + 1); if (low < 0) low += top + 1; } else low = 0;
      if (low <= this.bottoms[i]) this.flags[i] = 0x00; else if (low <= top) this.flags[i] = 0xFF;
      this.counters[i] = (this.counters[i] & 0x700) | low;
    }
  }

  hit(off) { if (off === 0xFF8 || off === 0xFF9) this.bank = off - 0xFF8; }

  read(a) {
    const off = a & 0x0FFF;
    if (off >= 0x40) { this.hit(off); return this.rom[this.bank * 4096 + off]; }
    const n = off & 7, fn = off >> 3;
    if (fn === 0) {
      if (n < 4) {
        // 8-bit shift register with feedback from bits 7, 5, 4 and 3.
        const r = this.random;
        this.random = ((r << 1) | (~((r >> 7) ^ (r >> 5) ^ (r >> 4) ^ (r >> 3)) & 1)) & 0xFF;
        return this.random;
      }
      this.updateMusic();
      const LEVEL = [0x0, 0x4, 0x5, 0x9, 0x6, 0xA, 0xB, 0xF];
      return LEVEL[(this.flags[5] & 1) | (this.flags[6] & 2) | (this.flags[7] & 4)];
    }
    if (n >= 5) this.updateMusic();
    const low = this.counters[n] & 0xFF;
    if (low === this.tops[n]) this.flags[n] = 0xFF; else if (low === this.bottoms[n]) this.flags[n] = 0x00;
    const d = this.gfx[2047 - this.counters[n]], f = this.flags[n];
    let v;
    switch (fn) {
      case 1: v = d; break;
      case 2: v = d & f; break;
      case 3: v = d & f; v = ((v << 4) | (v >> 4)) & 0xFF; break;
      case 4: v = d & f; v = parseInt(v.toString(2).padStart(8, '0').split('').reverse().join(''), 2); break;
      case 5: v = ((d & f) >> 1) | (((d & f) & 1) << 7); break;
      case 6: v = (((d & f) << 1) | ((d & f) >> 7)) & 0xFF; break;
      default: v = f;
    }
    if (n < 5 || !this.music[n - 5]) this.counters[n] = (this.counters[n] - 1) & 0x7FF;
    return v;
  }

  write(a, v) {
    const off = a & 0x0FFF;
    if (off < 0x40 || off >= 0x80) { this.hit(off); return; }
    const n = off & 7, fn = (off >> 3) & 7;
    if (n >= 5) this.updateMusic();
    switch (fn) {
      case 0: this.tops[n] = v; this.flags[n] = 0x00; break;
      case 1: this.bottoms[n] = v; break;
      case 2:
        // A fetcher in music mode reloads its low counter from its top.
        this.counters[n] = (this.counters[n] & 0x700) | (n >= 5 && this.music[n - 5] ? this.tops[n] : v);
        break;
      case 3:
        this.counters[n] = ((v & 7) << 8) | (this.counters[n] & 0xFF);
        if (n >= 5) this.music[n - 5] = v & 0x10 ? 1 : 0;
        break;
      case 6: this.random = 1; break;
    }
  }
}

// Starpath Supercharger (AR): the cart is 6K of RAM in three 2K banks plus a
// 2K BIOS ROM, loaded from cassette. Games come as one or more 8448-byte
// "loads": 8K of data in 256-byte pages plus a header giving the start
// address, the bank configuration, and where each page goes.
//
// The CPU writes the RAM in a roundabout way: reading $F0xx latches xx, and
// the fifth distinct bus access after that writes it, if writing is enabled.
// Reading $FFF8 instead sets the bank configuration from the latched byte:
//   bits 4-2: which banks sit at $F000 / $F800 (see AR_BANKS), bit 1: write
//   enable, bit 0: ROM power.
// The BIOS isn't included; this stands in for it. Its tape-loading entry at
// $F850 (and power-on) copies the requested load into RAM, sets up the
// configuration and jumps to the game. RAM $80 holds the load number going
// in and the configuration byte coming out.
const AR_BANKS = [[2, 3], [0, 3], [2, 0], [0, 2], [2, 3], [1, 3], [2, 1], [1, 2]];   // 3 = ROM
const AR_STATE = ['ram', 'config', 'writeEnabled', 'latch', 'pending', 'latchCount', 'distinct', 'lastAddr', 'booted', 'loadIndex'];
const AR_LOAD = 8448;
class AR {
  saveState() { return capture(this, AR_STATE); }
  loadState(s) { apply(this, AR_STATE, s); }

  constructor(rom) {
    this.name = 'AR';
    this.loads = [];
    for (let o = 0; o + AR_LOAD <= rom.length; o += AR_LOAD) this.loads.push(rom.subarray(o, o + AR_LOAD));
    this.ram = new Uint8Array(6144);
    // The stand-in BIOS: NOPs (the loader is a hotspot) and the reset vector.
    this.bios = new Uint8Array(2048).fill(0xEA);
    this.bios[0x7FC] = 0x50; this.bios[0x7FD] = 0xF8;
    this.setConfig(0);
    this.latch = 0; this.pending = false; this.latchCount = 0;
    this.distinct = 0; this.lastAddr = -1; this.booted = false;
    this.loadIndex = -1;
  }
  attach(console) { this.console = console; }

  setConfig(v) {
    this.config = v & 0x1F;
    this.writeEnabled = !!(v & 2);
  }

  bankAt(off) { return AR_BANKS[(this.config >> 2) & 7][off >> 11]; }

  // Load `n` by its multiload number, searching onward from the current load
  // as a tape would (Party Mix's games all share number 0); else the next
  // load. Then set the configuration and start the game.
  load(n) {
    const count = this.loads.length;
    let i = 1;
    while (i <= count && this.loads[(this.loadIndex + i) % count][8192 + 5] !== n) i++;
    this.loadIndex = (this.loadIndex + (i <= count ? i : 1)) % count;
    const ld = this.loads[this.loadIndex];
    const h = ld.subarray(8192);
    for (let p = 0; p < h[3]; p++) {
      const where = h[16 + p];
      this.ram.set(ld.subarray(p * 256, p * 256 + 256), (where & 3) * 2048 + ((where >> 2) & 7) * 256);
    }
    this.setConfig(h[2]);
    this.pending = false;
    // Like the real BIOS, leave the configuration byte at $80 for the game.
    if (this.console) this.console.riot.ram[0] = h[2];
    return h[0] | (h[1] << 8);
  }

  access(a) {
    if (a !== this.lastAddr) { this.distinct++; this.lastAddr = a; }
  }
  dummy(a) {
    if (a & 0x1000) this.read(a);
    this.access(a);
  }

  read(a) {
    const off = a & 0x0FFF, bank = this.bankAt(off);
    // The BIOS's loader: run the load and jump to the game (the CPU executes
    // a NOP here that lands it on the start address).
    if (bank === 3 && off === 0x850) {
      // From power-on, the BIOS clears the console's RAM before starting the
      // first load; later loads (multiload games) keep it.
      if (!this.booted) this.console.riot.ram.fill(0);
      const start = this.load(this.booted ? this.console.riot.ram[0] : 0);
      this.booted = true;
      this.console.cpu.pc = (start - 1) & 0xFFFF;
      return 0xEA;
    }
    // A pending write gives up after five distinct accesses.
    const since = this.distinct - this.latchCount;
    if (this.pending && since > 5) this.pending = false;
    if (!(off & 0xF00) && (!this.writeEnabled || !this.pending)) {
      this.latch = off & 0xFF; this.latchCount = this.distinct; this.pending = true;
    } else if (off === 0xFF8) {
      this.pending = false;
      this.setConfig(this.latch);
    } else if (this.writeEnabled && this.pending && since === 5) {
      if (bank !== 3) this.ram[bank * 2048 + (off & 0x7FF)] = this.latch;
      this.pending = false;
    }
    return bank === 3 ? this.bios[off & 0x7FF] : this.ram[bank * 2048 + (off & 0x7FF)];
  }
  write() {}
}

const E0_SIGS = [[0x8D, 0xE0, 0x1F], [0x8D, 0xE0, 0x5F], [0x8D, 0xE9, 0xFF], [0x0C, 0xE0, 0x1F],
  [0xAD, 0xE0, 0x1F], [0xAD, 0xE9, 0xFF], [0xAD, 0xED, 0xFF], [0xAD, 0xF3, 0xBF], [0xAD, 0xE0, 0xFF], [0xAD, 0xE3, 0xFF]];
const E7_SIGS = [[0xAD, 0xE2, 0xFF], [0xAD, 0xE5, 0xFF], [0xAD, 0xE5, 0x1F], [0xAD, 0xE7, 0x1F],
  [0x0C, 0xE7, 0x1F], [0x8D, 0xE7, 0xFF], [0x8D, 0xE7, 0x1F]];

// Signatures: short code sequences that only carts of a type contain.
const FE_SIGS = [[0x20, 0x00, 0xD0, 0xC6, 0xC5], [0x20, 0xC3, 0xF8, 0xA5, 0x82], [0x20, 0x58, 0xD9, 0xA5, 0x83],
  [0x20, 0x3B, 0xF5, 0x4C, 0x3B]];            // Decathlon, Robot Tank, Space Shuttle, Thwocker
const UA_SIGS = [[0x8D, 0x40, 0x02], [0xAD, 0x40, 0x02], [0xBD, 0x1F, 0x02], [0x2C, 0xC0, 0x02], [0x8D, 0xC0, 0x02], [0xAD, 0xC0, 0x02]];
const E0840_SIGS = [[0xAD, 0x00, 0x08], [0xAD, 0x40, 0x08], [0x2C, 0x40, 0x08]];
// Absolute references to the F8 hotspots ($1FF8/$1FF9 and mirrors), which
// rule out the carts that switch banks elsewhere.
function usesF8Hotspots(rom) {
  for (let i = 0; i < rom.length - 2; i++) {
    if ((rom[i + 1] === 0xF8 || rom[i + 1] === 0xF9) && (rom[i + 2] & 0x1F) === 0x1F &&
      [0xAD, 0x8D, 0x2C, 0xCD, 0xBD, 0x9D, 0xB9, 0x99].includes(rom[i])) return true;
  }
  return false;
}
const CV_SIGS = [[0x9D, 0xFF, 0xF3], [0x99, 0x00, 0xF4]];
const SB_SIGS = [[0xBD, 0x00, 0x08], [0xAD, 0x00, 0x08]];
const text = (s) => [...s].map((c) => c.charCodeAt(0));
const some = (rom, sigs) => sigs.some((s) => hasSig(rom, s));

export function createCart(data) {
  let rom = data instanceof Uint8Array ? data : new Uint8Array(data);
  const size = rom.length;
  // Supercharger tapes: whole 8448-byte loads.
  if (size % AR_LOAD === 0) return new AR(rom);
  if (size === 10240 || size === 10495) return new DPC(rom);
  if ((size === 2048 || size === 4096) && some(rom, CV_SIGS)) return new CV(rom);
  if (size <= 2048) {
    const r = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) r[i] = rom[i % size];
    return new Flat(r);
  }
  if (size === 4096) return new Flat(rom);
  if (hasSig(rom, [0x85, 0x3E]) && hasSig(rom, [0x85, 0x3F]) && size % 2048 === 0) return new T3E(rom);
  if (hasSig(rom, [0x85, 0x3F], 2) && size % 2048 === 0 && size !== 12288 && !E0_SIGS.some(s => hasSig(rom, s))) {
    if (size !== 8192 || !isSuperchip(rom)) return new T3F(rom);
  }
  if (size === 8192) {
    if (E0_SIGS.some(s => hasSig(rom, s))) return new E0(rom);
    if (E7_SIGS.some(s => hasSig(rom, s))) return new E7(rom);
    if (some(rom, FE_SIGS)) return new FE(rom);
    if (!usesF8Hotspots(rom)) {
      if (some(rom, UA_SIGS)) return new BusHotspot(rom, 'UA', 0x1260, 0x0220, 0x0240);
      if (some(rom, E0840_SIGS)) return new BusHotspot(rom, '0840', 0x1840, 0x0800, 0x0840);
    }
    const sc = isSuperchip(rom);
    return new Hotspot(rom, 0xFF8, 2, sc ? 'F8SC' : 'F8', sc ? 128 : 0);
  }
  if (size === 12288) return new Hotspot(rom, 0xFF8, 3, 'FA', 256);
  if (size === 16384) {
    if (E7_SIGS.some(s => hasSig(rom, s))) return new E7(rom);
    const sc = isSuperchip(rom);
    return new Hotspot(rom, 0xFF6, 4, sc ? 'F6SC' : 'F6', sc ? 128 : 0);
  }
  if (size === 32768) {
    const sc = isSuperchip(rom);
    return new Hotspot(rom, 0xFF4, 8, sc ? 'F4SC' : 'F4', sc ? 128 : 0);
  }
  // Homebrew banking for big carts, marked by a tag in the ROM ("EFEF",
  // "EFSC" and so on); else by size.
  if (size === 65536) {
    if (hasSig(rom, text('EFSC'))) return new Hotspot(rom, 0xFE0, 16, 'EFSC', 128);
    if (hasSig(rom, text('EFEF'))) return new Hotspot(rom, 0xFE0, 16, 'EF');
    if (some(rom, SB_SIGS)) return new SB(rom);
    if (hasSig(rom, [0xAD, 0xF0, 0xFF]) || hasSig(rom, [0x8D, 0xF0, 0xFF])) return new F0(rom);
    return new Hotspot(rom, 0xFE0, 16, isSuperchip(rom) ? 'EFSC' : 'EF', isSuperchip(rom) ? 128 : 0);
  }
  if (size === 131072) {
    if (hasSig(rom, text('DFSC'))) return new Hotspot(rom, 0xFC0, 32, 'DFSC', 128);
    if (hasSig(rom, text('DFDF'))) return new Hotspot(rom, 0xFC0, 32, 'DF');
    return new SB(rom);
  }
  if (size === 262144) {
    if (hasSig(rom, text('BFSC'))) return new Hotspot(rom, 0xF80, 64, 'BFSC', 128);
    if (hasSig(rom, text('BFBF'))) return new Hotspot(rom, 0xF80, 64, 'BF');
    return new SB(rom);
  }
  // Unknown size: pad/truncate to 4K and hope for the best.
  const r = new Uint8Array(4096);
  r.set(rom.subarray(rom.length - Math.min(4096, rom.length)));
  return new Flat(r);
}
