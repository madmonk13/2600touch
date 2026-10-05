// Cartridge mappers. Each takes the ROM image and exposes
//   read(addr), write(addr, v)  — addr is in the 4K cart window ($1000-$1FFF)
//   snoop(addr, v)              — optional: sees writes below $1000 (used by 3F)

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

class Flat {
  constructor(rom) { this.rom = rom; this.mask = rom.length - 1; this.name = rom.length === 2048 ? '2K' : '4K'; }
  read(a) { return this.rom[a & this.mask]; }
  write() {}
}

// F8 / F6 / F4 / FA style: hotspots near the top of the address space pick a 4K bank.
class Hotspot {
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
class E0 {
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
class T3F {
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
class E7 {
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

const E0_SIGS = [[0x8D, 0xE0, 0x1F], [0x8D, 0xE0, 0x5F], [0x8D, 0xE9, 0xFF], [0x0C, 0xE0, 0x1F],
  [0xAD, 0xE0, 0x1F], [0xAD, 0xE9, 0xFF], [0xAD, 0xED, 0xFF], [0xAD, 0xF3, 0xBF]];
const E7_SIGS = [[0xAD, 0xE2, 0xFF], [0xAD, 0xE5, 0xFF], [0xAD, 0xE5, 0x1F], [0xAD, 0xE7, 0x1F],
  [0x0C, 0xE7, 0x1F], [0x8D, 0xE7, 0xFF], [0x8D, 0xE7, 0x1F]];

export function createCart(data) {
  let rom = data instanceof Uint8Array ? data : new Uint8Array(data);
  const size = rom.length;
  if (size <= 2048) {
    const r = new Uint8Array(2048);
    for (let i = 0; i < 2048; i++) r[i] = rom[i % size];
    return new Flat(r);
  }
  if (size === 4096) return new Flat(rom);
  if (hasSig(rom, [0x85, 0x3F], 2) && size % 2048 === 0 && size !== 12288 && !E0_SIGS.some(s => hasSig(rom, s))) {
    if (size !== 8192 || !isSuperchip(rom)) return new T3F(rom);
  }
  if (size === 8192) {
    if (E0_SIGS.some(s => hasSig(rom, s))) return new E0(rom);
    if (E7_SIGS.some(s => hasSig(rom, s))) return new E7(rom);
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
  // Unknown size: pad/truncate to 4K and hope for the best.
  const r = new Uint8Array(4096);
  r.set(rom.subarray(rom.length - Math.min(4096, rom.length)));
  return new Flat(r);
}
