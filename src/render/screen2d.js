// Draws a TIA frame to a 160-pixel-wide canvas (scaled up with CSS).

import { NTSC_PALETTE } from '../emu/palette.js';
import { WIDTH } from '../emu/tia.js';

export class Screen2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;
  }

  draw(frame, win) {
    const h = win.height;
    if (!this.image || this.image.height !== h) {
      this.canvas.width = WIDTH;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(WIDTH, h);
    }
    const d = this.image.data;
    for (let l = 0; l < h; l++) {
      const visible = frame.lineVisible[win.top + l];
      const row = (win.top + l) * WIDTH;
      for (let x = 0; x < WIDTH; x++) {
        const rgb = visible ? NTSC_PALETTE[frame.color[row + x]] : 0;
        const o = (l * WIDTH + x) * 4;
        d[o] = rgb >> 16; d[o + 1] = (rgb >> 8) & 255; d[o + 2] = rgb & 255; d[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
