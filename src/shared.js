// ROM file reading, storage, loading modal, toast and window tracking.

import { extractRom, isZip, isGzip } from './unzip.js';
import { MAX_LINES } from './emu/tia.js';

const STORE = '2600touch:';
const LEGACY_STORE = '3d2600:';

// Carry the collection and settings over from the app's previous name.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(LEGACY_STORE)) continue;
    const next = STORE + key.slice(LEGACY_STORE.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* storage unavailable or full */ }

export const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(STORE + key)); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(STORE + key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  remove(key) { try { localStorage.removeItem(STORE + key); } catch { /* storage unavailable */ } },
  // Like set, but reports whether the write landed (false when full or blocked).
  trySet(key, v) {
    try { localStorage.setItem(STORE + key, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch { return false; }
  },
  getRaw(key) { try { return localStorage.getItem(STORE + key); } catch { return null; } },
};

// Read a user-picked file, unpacking .zip/.gz. Returns { bytes, name } with the
// ROM extension stripped from the name.
export async function readRomFile(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (isZip(bytes) || isGzip(bytes)) ({ bytes, name } = await extractRom(bytes, name));
  return { bytes, name: name.replace(/\.(a26|bin|rom)$/i, '') };
}

export async function fetchRom(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Show the loading modal (#loading / #loadingName) for the duration of
// `work`, and at least briefly so fast loads don't flicker.
export async function withLoading(label, work) {
  const el = document.getElementById('loading');
  document.getElementById('loadingName').textContent = label;
  el.classList.add('show');
  const started = performance.now();
  try {
    return await work();
  } finally {
    const wait = 450 - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    el.classList.remove('show');
  }
}

let toastTimer = 0;
// Short message at the bottom of the screen; errors unless `info` is set.
export function toast(msg, { info = false } = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('info', info);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// Keep the rendered window steady: only adopt a new visible scanline range
// once it has held for a number of frames (games often wobble a line or two).
const MAX_SETTLE = 3; // lines a frame's picture may start early/late and still be followed
export class WindowTracker {
  constructor() { this.reset(); }
  reset() {
    this.win = { top: 40, height: 192 };
    this.have = false;
    this.pending = null;
    this.pendingCount = 0;
  }
  update(f) {
    const h = Math.min(240, f.lastVisible - f.firstVisible + 1);
    if (h < 60) return this.win;
    const t = f.firstVisible;
    if (!this.have) { this.win = { top: t, height: h }; this.have = true; return this.win; }
    if (t === this.win.top && h === this.win.height) { this.pending = null; return this.win; }
    // Same picture, starting a line or two early or late. Some games (Frogger,
    // for one) finish their vertical-blank work a line late every so often, which
    // a CRT smooths over; follow the picture so it doesn't hop. Layout is driven
    // by win.height, which doesn't change.
    if (h === this.win.height && Math.abs(t - this.win.top) <= MAX_SETTLE) {
      return { top: Math.min(t, MAX_LINES - h), height: h };
    }
    if (this.pending && this.pending.top === t && this.pending.height === h) {
      if (++this.pendingCount > 20) { this.win = this.pending; this.pending = null; }
    } else {
      this.pending = { top: t, height: h };
      this.pendingCount = 1;
    }
    return this.win;
  }
}
