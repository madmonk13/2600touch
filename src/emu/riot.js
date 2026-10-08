// 6532 RIOT: 128 bytes of RAM, joystick/console-switch ports, interval timer.
// The timer is evaluated lazily from the CPU cycle count.

import { capture, apply } from './state.js';

const RIOT_STATE = ['ram', 'swacnt', 'swbcnt', 'swaOut', 'timerStart', 'timerValue', 'timerShift', 'timerFlag', 'flagCleared'];
export class RIOT {
  saveState() { return capture(this, RIOT_STATE); }
  loadState(s) { apply(this, RIOT_STATE, s); }

  constructor() {
    this.ram = new Uint8Array(128);
    this.input = {
      // Active-low bits, as the hardware reports them.
      swcha: 0xFF,        // P0: b7 right, b6 left, b5 down, b4 up; P1 in low nibble
      reset: false, select: false, color: true,
      diff0: false, diff1: false,   // false = B (novice), true = A (pro)
    };
    this.reset();
  }

  reset() {
    for (let i = 0; i < 128; i++) this.ram[i] = (Math.random() * 256) | 0;
    this.swacnt = 0; this.swbcnt = 0; this.swaOut = 0;
    this.timerStart = 0;
    this.timerValue = (Math.random() * 256) | 0;
    this.timerShift = 10; // T1024T
    this.timerFlag = 0;
    this.flagCleared = -1;
  }

  // Timer state at `cycle`: { value, underflowed }.
  timerAt(cycle) {
    const d = Math.max(0, cycle - this.timerStart);
    const interval = 1 << this.timerShift;
    const tu = (this.timerValue + 1) * interval;
    if (d < tu) return { value: this.timerValue - Math.floor(d / interval), under: false, tu };
    return { value: (0xFF - (d - tu)) & 0xFF, under: true, tu };
  }

  swchb() {
    const i = this.input;
    return (i.reset ? 0 : 1) | (i.select ? 0 : 2) | 0x04 | (i.color ? 8 : 0) | 0x30 |
      (i.diff0 ? 0x40 : 0) | (i.diff1 ? 0x80 : 0);
  }

  readIO(addr, cycle) {
    if (addr & 0x04) {
      const t = this.timerAt(cycle);
      if (addr & 0x01) {
        // TIMINT: D7 = timer underflowed since the last INTIM read / timer write.
        const flagged = t.under && (this.timerStart + t.tu) > this.flagCleared;
        return flagged ? 0x80 : 0;
      }
      if (t.under) this.flagCleared = cycle;
      return t.value;
    }
    switch (addr & 0x03) {
      case 0: return this.input.swcha & ~this.swacnt | (this.swaOut & this.swacnt);
      case 1: return this.swacnt;
      case 2: return this.swchb();
      case 3: return this.swbcnt;
    }
    return 0;
  }

  writeIO(addr, v, cycle) {
    if ((addr & 0x14) === 0x14) {
      this.timerShift = [0, 3, 6, 10][addr & 0x03];
      this.timerValue = v;
      this.timerStart = cycle + 1;
      this.flagCleared = cycle;
      return;
    }
    if ((addr & 0x04) === 0) {
      switch (addr & 0x03) {
        case 0: this.swaOut = v; break;
        case 1: this.swacnt = v; break;
        case 3: this.swbcnt = v; break;
      }
    }
  }
}
