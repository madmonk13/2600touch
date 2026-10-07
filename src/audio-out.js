// Browser audio sink for the TIA sample ring buffer. Must be started from a
// user gesture.
//
// Mobile browsers (iOS especially) can leave the context 'suspended' or
// 'interrupted' after backgrounding, a call or another app taking audio, and
// sometimes leave it 'running' while the processor has quietly stopped. start()
// is called on every user gesture and repairs whichever of these it finds.

const STALL_MS = 1000;   // no audio callback for this long while running = stalled

export class AudioOut {
  constructor(tiaAudio) {
    this.source = tiaAudio;
    this.ctx = null;
    this.muted = false;
    this.lastProcess = 0;
  }

  start() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (this.ctx && this.ctx.state === 'running' && this.stalled()) this.rebuild();
    if (!this.ctx || this.ctx.state === 'closed') this.create(Ctx);
    this.resume();
    this.kick();
  }

  // Resume a suspended or interrupted context. Safe outside a gesture: it just
  // fails quietly and the next gesture tries again.
  resume() {
    if (!this.ctx || this.ctx.state === 'running' || this.ctx.state === 'closed') return;
    this.lastProcess = performance.now(); // don't mistake the restart for a stall
    this.ctx.resume().catch(() => {});
  }

  create(Ctx) {
    this.ctx = new Ctx();
    const node = this.ctx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => {
      this.lastProcess = performance.now();
      const out = e.outputBuffer.getChannelData(0);
      if (this.muted) { out.fill(0); this.source.readPos = this.source.writePos; return; }
      this.source.pull(out, this.ctx.sampleRate);
    };
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.5;
    node.connect(this.gain).connect(this.ctx.destination);
    this.node = node;
    this.lastProcess = performance.now();
  }

  rebuild() {
    try { this.node.disconnect(); } catch { /* already gone */ }
    this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  stalled() {
    return !document.hidden && performance.now() - this.lastProcess > STALL_MS;
  }

  // Play one silent sample inside the gesture: iOS only fully unlocks output
  // once a source has actually started from a user action.
  kick() {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.start(0);
    } catch { /* not ready yet; the next gesture tries again */ }
  }

  setMuted(m) {
    // Drop anything queued while muted so sound resumes in sync with the game.
    if (this.muted && !m) this.source.readPos = this.source.writePos;
    this.muted = m;
  }
}
