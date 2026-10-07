// Keyboard + gamepad → joystick, paddle and console-switch state.

const P0_KEYS = {
  ArrowUp: 0x10, KeyW: 0x10, ArrowDown: 0x20, KeyS: 0x20,
  ArrowLeft: 0x40, KeyA: 0x40, ArrowRight: 0x80, KeyD: 0x80,
};
// Full sweep of the paddle per second at full deflection.
const PADDLE_SPEED = 1.1;

const P1_KEYS = { KeyI: 0x01, KeyK: 0x02, KeyJ: 0x04, KeyL: 0x08 };
const FIRE0 = new Set(['Space', 'KeyZ', 'KeyX']);
const FIRE1 = new Set(['KeyU']);
// Console switches: Return or 2 = Reset, Tab or 1 = Select.
const RESET_KEYS = ['Enter', 'NumpadEnter', 'Digit2'];
const SELECT_KEYS = ['Tab', 'Digit1'];
const GAME_KEYS = new Set([...Object.keys(P0_KEYS), ...Object.keys(P1_KEYS), ...FIRE0, ...FIRE1,
  ...RESET_KEYS, ...SELECT_KEYS]);

export class Input {
  constructor(atari) {
    this.atari = atari;
    this.keys = new Set();
    this.paddleMode = false;
    this.paddlePos = 0.5;     // 0 = fully left, 1 = fully right
    this.uiReset = false;
    this.uiSelect = false;
    // Extra player-0 sources (e.g. touch controls): objects with dir() → SWCHA
    // direction bits (0x10 up, 0x20 down, 0x40 left, 0x80 right), fire() → bool
    // and optionally paddleRate() → turn rate in [-1, 1].
    this.sources = [];
    window.addEventListener('keydown', (e) => {
      if (!GAME_KEYS.has(e.code) || e.metaKey || e.ctrlKey || e.altKey) return;
      // While a full-screen sheet is open, keys (Tab and Return especially) belong
      // to its controls, not the paused game.
      if (document.querySelector('.sheet-backdrop:not([hidden])')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) t.blur();
      e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update() {
    const k = this.keys;
    let p0 = 0, p1 = 0, fire0 = false, fire1 = false;
    let reset = this.uiReset || RESET_KEYS.some((c) => k.has(c));
    let select = this.uiSelect || SELECT_KEYS.some((c) => k.has(c));
    for (const code of k) {
      if (P0_KEYS[code]) p0 |= P0_KEYS[code];
      if (P1_KEYS[code]) p1 |= P1_KEYS[code];
      if (FIRE0.has(code)) fire0 = true;
      if (FIRE1.has(code)) fire1 = true;
    }

    let rate = 0;
    for (const src of this.sources) {
      p0 |= src.dir();
      fire0 ||= src.fire();
      if (src.paddleRate) rate += src.paddleRate();
    }

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let slot = 0;
    for (const pad of pads) {
      if (!pad || slot > 1) continue;
      const b = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      let d = 0;
      if (ay < -0.5 || b(12)) d |= 0x10;
      if (ay > 0.5 || b(13)) d |= 0x20;
      if (ax < -0.5 || b(14)) d |= 0x40;
      if (ax > 0.5 || b(15)) d |= 0x80;
      const fire = b(0) || b(1) || b(2) || b(3);
      if (slot === 0) { p0 |= d; fire0 ||= fire; rate += Math.abs(ax) > 0.15 ? ax : 0; } else { p1 |= d >> 4; fire1 ||= fire; }
      if (b(9)) reset = true;
      if (b(8)) select = true;
      slot++;
    }

    const riot = this.atari.riot.input, tia = this.atari.tia.input;
    riot.swcha = 0xFF & ~(p0 | p1);
    riot.reset = reset;
    riot.select = select;
    tia.fire0 = fire0;
    tia.fire1 = fire1;
    tia.paddleMode = this.paddleMode;
    if (this.paddleMode) {
      // Paddle 0 turns at a rate set by the touch pad, left/right keys or the
      // gamepad stick. Its button is read through the joystick port, so the
      // joystick direction bits are left alone.
      if (p0 & 0x40) rate -= 1;
      if (p0 & 0x80) rate += 1;
      rate = Math.max(-1, Math.min(1, rate));
      this.paddlePos = Math.max(0, Math.min(1, this.paddlePos + rate * PADDLE_SPEED / 60));
      tia.paddles[0] = 1 - this.paddlePos;
      riot.swcha = 0xFF & ~(p1 & 0x0F);
      if (fire0) riot.swcha &= ~0x80;
      tia.fire0 = false; // a paddle button isn't the joystick fire line
    }
  }
}
