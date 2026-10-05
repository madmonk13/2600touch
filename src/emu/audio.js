// TIA audio: two channels of divided/polynomial waveforms, sampled twice per
// scanline (~31.4 kHz). Samples go into a ring buffer that the browser audio
// output resamples from.

export const TIA_SAMPLE_RATE = 31440;

class Channel {
  constructor() { this.reset(); }
  reset() {
    this.audc = 0; this.audf = 0; this.audv = 0;
    this.div = 0; this.out = 0;
    this.poly4 = 0x0F; this.poly5 = 0x1F; this.poly9 = 0x1FF;
    this.count = 0;
  }
  stepPoly4() { const p = this.poly4; this.poly4 = ((p << 1) | (((p >> 3) ^ (p >> 2)) & 1)) & 0x0F; return this.poly4 & 1; }
  stepPoly5() { const p = this.poly5; this.poly5 = ((p << 1) | (((p >> 4) ^ (p >> 2)) & 1)) & 0x1F; return this.poly5 & 1; }
  stepPoly9() { const p = this.poly9; this.poly9 = ((p << 1) | (((p >> 8) ^ (p >> 4)) & 1)) & 0x1FF; return this.poly9 & 1; }

  clock() {
    if (++this.div <= this.audf) return;
    this.div = 0;
    switch (this.audc) {
      case 0: case 11: this.out = 1; break;
      case 1: this.out = this.stepPoly4(); break;
      case 2: if (++this.count >= 15) { this.count = 0; this.out = this.stepPoly4(); } break;
      case 3: if (this.stepPoly5()) this.out = this.stepPoly4(); break;
      case 4: case 5: this.out ^= 1; break;
      case 6: case 10: this.count = (this.count + 1) % 31; this.out = this.count < 18 ? 1 : 0; break;
      case 7: if (this.stepPoly5()) this.out ^= 1; break;
      case 8: this.out = this.stepPoly9(); break;
      case 9: this.out = this.stepPoly5(); break;
      case 12: case 13: if (++this.count >= 3) { this.count = 0; this.out ^= 1; } break;
      case 14: this.count = (this.count + 1) % 93; this.out = this.count < 47 ? 1 : 0; break;
      case 15: if (this.stepPoly5() && ++this.count >= 3) { this.count = 0; this.out ^= 1; } break;
    }
  }
}

export class TIAAudio {
  constructor() {
    this.ch = [new Channel(), new Channel()];
    this.buffer = new Float32Array(1 << 15);
    this.writePos = 0;
    this.readPos = 0;
    this.dcIn = 0; this.dcOut = 0;
  }

  reset() {
    this.ch[0].reset(); this.ch[1].reset();
    this.writePos = this.readPos = 0;
  }

  write(reg, v) {
    switch (reg) {
      case 0x15: this.ch[0].audc = v & 0x0F; break;
      case 0x16: this.ch[1].audc = v & 0x0F; break;
      case 0x17: this.ch[0].audf = v & 0x1F; break;
      case 0x18: this.ch[1].audf = v & 0x1F; break;
      case 0x19: this.ch[0].audv = v & 0x0F; break;
      case 0x1A: this.ch[1].audv = v & 0x0F; break;
    }
  }

  sample() {
    const a = this.ch[0], b = this.ch[1];
    a.clock(); b.clock();
    const raw = (a.out * a.audv + b.out * b.audv) / 30;
    // DC-blocking high-pass so constant-level channels stay silent.
    const s = raw - this.dcIn + 0.995 * this.dcOut;
    this.dcIn = raw; this.dcOut = s;
    const buf = this.buffer;
    buf[this.writePos] = s;
    this.writePos = (this.writePos + 1) & (buf.length - 1);
    if (this.writePos === this.readPos) this.readPos = (this.readPos + 1) & (buf.length - 1);
  }

  available() {
    return (this.writePos - this.readPos) & (this.buffer.length - 1);
  }

  // Fill `out` at `outRate` with linear resampling. Keeps latency bounded by
  // skipping ahead when the buffer runs too full.
  pull(out, outRate) {
    const buf = this.buffer, mask = buf.length - 1;
    const step = TIA_SAMPLE_RATE / outRate;
    const maxBacklog = TIA_SAMPLE_RATE * 0.12;
    if (this.available() > maxBacklog) this.readPos = (this.writePos - Math.floor(TIA_SAMPLE_RATE * 0.05)) & mask;
    let pos = this.frac || 0;
    let last = this.last || 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available() < 2) { out[i] = last *= 0.995; continue; }
      const s0 = buf[this.readPos], s1 = buf[(this.readPos + 1) & mask];
      last = out[i] = s0 + (s1 - s0) * pos;
      pos += step;
      while (pos >= 1 && this.available() > 1) { pos -= 1; this.readPos = (this.readPos + 1) & mask; }
    }
    this.frac = pos;
    this.last = last;
  }
}
