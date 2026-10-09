// The console: wires CPU, TIA, RIOT and cartridge onto the 6507's 13-bit bus.

import { CPU6502 } from './cpu6502.js';
import { TIA } from './tia.js';
import { RIOT } from './riot.js';
import { createCart } from './cart.js';
import { capture, apply } from './state.js';

const CYCLES_PER_LINE = 76;

const ATARI_STATE = ['cpu', 'tia', 'riot', 'cart', 'frameDone'];
export class Atari2600 {
  saveState() { return capture(this, ATARI_STATE); }
  loadState(s) { apply(this, ATARI_STATE, s); }

  constructor() {
    this.tia = new TIA();
    this.riot = new RIOT();
    this.cart = null;
    this.cpu = new CPU6502(this);
    this.frameDone = false;
    this.dataBus = 0;
    this.tia.onFrame = () => { this.frameDone = true; };
  }

  load(romData) {
    this.cart = createCart(romData);
    if (this.cart.attach) this.cart.attach(this);   // carts that need the CPU clock or RAM
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
    let v;
    if (addr & 0x1000) v = this.cart.read(addr);
    // The TIA drives only data bits 7 and 6; the rest keep whatever was last
    // on the bus (Haunted House counts on it).
    else if (!(addr & 0x80)) v = (this.tia.read(addr, this.cpu.busCycle) & 0xC0) | (this.dataBus & 0x3F);
    else if (addr & 0x200) v = this.riot.readIO(addr, this.cpu.busCycle);
    else v = this.riot.ram[addr & 0x7F];
    // Some carts watch the whole bus (Activision's stack-watching FE, UA,
    // the Supercharger's write timing).
    if (this.cart.access) this.cart.access(addr, v);
    this.dataBus = v;
    return v;
  }

  // Bus cycles the 6502 spends reading an address it then ignores (see
  // cpu6502.js). Only the Supercharger cares: its write timing counts them.
  dummy(addr) {
    if (this.cart.dummy) this.cart.dummy(addr & 0x1FFF);
  }

  write(addr, v) {
    addr &= 0x1FFF;
    this.dataBus = v;
    if (this.cart.access) this.cart.access(addr, v);
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
