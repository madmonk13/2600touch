// The console: wires CPU, TIA, RIOT and cartridge onto the 6507's 13-bit bus.

import { CPU6502 } from './cpu6502.js';
import { TIA } from './tia.js';
import { RIOT } from './riot.js';
import { createCart } from './cart.js';

const CYCLES_PER_LINE = 76;

export class Atari2600 {
  constructor() {
    this.tia = new TIA();
    this.riot = new RIOT();
    this.cart = null;
    this.cpu = new CPU6502(this);
    this.frameDone = false;
    this.tia.onFrame = () => { this.frameDone = true; };
  }

  load(romData) {
    this.cart = createCart(romData);
    this.reset();
    return this.cart.name;
  }

  reset() {
    this.tia.reset();
    this.riot.reset();
    this.cpu.cycles = 0;
    this.cpu.busCycle = 0;
    this.cpu.reset();
  }

  read(addr) {
    addr &= 0x1FFF;
    if (addr & 0x1000) return this.cart.read(addr);
    if (!(addr & 0x80)) return this.tia.read(addr, this.cpu.busCycle);
    if (addr & 0x200) return this.riot.readIO(addr, this.cpu.busCycle);
    return this.riot.ram[addr & 0x7F];
  }

  write(addr, v) {
    addr &= 0x1FFF;
    if (addr & 0x1000) { this.cart.write(addr, v); return; }
    if (this.cart.snoop) this.cart.snoop(addr, v);
    if (!(addr & 0x80)) { this.tia.write(addr, v, this.cpu.busCycle); return; }
    if (addr & 0x200) { this.riot.writeIO(addr, v, this.cpu.busCycle); return; }
    this.riot.ram[addr & 0x7F] = v;
  }

  // Run until the TIA finishes a frame (VSYNC), with a safety cap.
  runFrame() {
    if (!this.cart) return;
    const cpu = this.cpu, tia = this.tia;
    const limit = cpu.cycles + CYCLES_PER_LINE * 400;
    this.frameDone = false;
    while (!this.frameDone && cpu.cycles < limit) {
      cpu.step();
      if (tia.wsync) {
        tia.wsync = false;
        cpu.cycles = Math.ceil(cpu.cycles / CYCLES_PER_LINE) * CYCLES_PER_LINE;
      }
    }
    tia.catchUp(cpu.cycles * 3);
    if (!this.frameDone) tia.endFrame();
  }
}
