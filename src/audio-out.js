// Browser audio sink for the TIA sample ring buffer. Must be started from a
// user gesture.

export class AudioOut {
  constructor(tiaAudio) {
    this.source = tiaAudio;
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    const node = this.ctx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      if (this.muted) { out.fill(0); this.source.readPos = this.source.writePos; return; }
      this.source.pull(out, this.ctx.sampleRate);
    };
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.5;
    node.connect(this.gain).connect(this.ctx.destination);
    this.node = node;
  }

  setMuted(m) { this.muted = m; }
}
