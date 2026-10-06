import { Atari2600 } from './emu/atari.js';
import { Screen2D } from './render/screen2d.js';
import { Input } from './input.js';
import { AudioOut } from './audio-out.js';
import { store, readRomFile, fetchRom, withLoading, toast, WindowTracker } from './shared.js';
import { library, renderLibrary, DEMO_ID } from './library.js';
import { TouchControls } from './touch.js';

const $ = (id) => document.getElementById(id);
const FRAME_TIME = 1 / 60;
const LY = 0.55;               // scanline height / pixel width (approximate TV aspect)
const MIN_BUTTON_MS = 120;     // console switches stay down at least this long

const DEFAULTS = {
  leftHanded: false,
  eightWay: true,
  dpadSize: 140,
  haptics: true,
  hints: true,
  sound: true,
};

const atari = new Atari2600();
const input = new Input(atari);
const audio = new AudioOut(atari.tia.audio);
const screen2d = new Screen2D($('screen2d'));
const windowTracker = new WindowTracker();
const touch = new TouchControls({ surface: $('surface'), dpad: $('dpad'), ripples: $('ripples') });
input.sources.push(touch);

const settings = { ...DEFAULTS, ...(store.get('mobile') || {}) };
const state = { romId: null, menuOpen: false };

// Block page-level zoom/scroll gestures; this is a full-screen app.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.sheet')) e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------- audio

// iOS only unlocks audio inside a user gesture, so try on every touch.
const unlockAudio = () => { if (settings.sound) audio.start(); };
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('pointerup', unlockAudio);

// ---------------------------------------------------------------- ROMs

// Load a cart into the console and record it in the collection.
function loadRom(bytes, name, id) {
  const mapper = atari.load(bytes);
  windowTracker.reset();
  let saved = true;
  if (id !== DEMO_ID) {
    const res = library.add(name, bytes, mapper);
    id = res.id;
    saved = res.stored;
    if (!saved) toast('Storage is full, so this cart won\'t be saved. Remove some to make room.');
  }
  state.romId = id;
  if (saved) library.setLast(id);
  refreshLibrary();
}

function refreshLibrary() {
  renderLibrary($('library'), {
    currentId: state.romId,
    onPlay: (entry) => playEntry(entry),
    onRemove: (entry) => { library.remove(entry.id); refreshLibrary(); },
  });
  const n = library.list().length;
  $('libraryInfo').textContent = n
    ? `${n} saved · ${Math.ceil(library.usage() / 1024)} KB on this device`
    : 'Carts you add are saved on this device.';
}

async function playEntry(entry) {
  try {
    await withLoading(entry.name, async () => {
      if (entry.id === DEMO_ID) return loadDemoNow();
      const bytes = library.get(entry.id);
      if (!bytes) throw new Error('its saved data is missing');
      loadRom(bytes, entry.name, entry.id);
    });
    closeMenu();
  } catch (err) {
    toast(`Couldn't load ${entry.name}: ${err.message}`);
  }
}

async function loadDemoNow() {
  loadRom(await fetchRom('roms/demo.bin'), 'Demo cart', DEMO_ID);
}

async function loadFile(file) {
  try {
    await withLoading(file.name, async () => {
      const { bytes, name } = await readRomFile(file);
      loadRom(bytes, name);
    });
    closeMenu();
  } catch (err) {
    toast(`Couldn't load ${file.name}: ${err.message}`);
  }
}

$('loadBtn').addEventListener('click', () => $('romFile').click());
$('romFile').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });

// ---------------------------------------------------------------- menu

// The game pauses and the touch controls go inert while settings are open.
function openMenu() {
  state.menuOpen = true;
  touch.releaseAll();
  touch.enabled = false;
  audio.setMuted(true);
  $('menu').hidden = false;
}
function closeMenu() {
  state.menuOpen = false;
  touch.enabled = true;
  audio.setMuted(!settings.sound);
  $('menu').hidden = true;
}
$('menuBtn').addEventListener('click', openMenu);
$('closeMenu').addEventListener('click', closeMenu);
$('menu').addEventListener('click', (e) => { if (e.target === $('menu')) closeMenu(); });

function save() { store.set('mobile', settings); }

function applyControls() {
  document.body.classList.toggle('lefty', settings.leftHanded);
  touch.leftHanded = settings.leftHanded;
  touch.eightWay = settings.eightWay;
  touch.haptics = settings.haptics;
  touch.setSize(settings.dpadSize);
  $('dpadSizeVal').textContent = `${settings.dpadSize}px`;
  for (const b of document.querySelectorAll('[data-dirs]')) {
    b.classList.toggle('active', (b.dataset.dirs === '8') === settings.eightWay);
  }
}

function syncMenu() {
  $('leftHanded').checked = settings.leftHanded;
  $('dpadSize').value = settings.dpadSize;
  $('haptics').checked = settings.haptics;
  $('hints').checked = settings.hints;
  $('sound').checked = settings.sound;
  $('hapticsRow').hidden = !navigator.vibrate;
  applyControls();
}

let hintTimer = 0;
function flashHints(ms) {
  if (!settings.hints) return;
  document.body.classList.add('show-hints');
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), ms);
}

$('leftHanded').addEventListener('change', (e) => {
  settings.leftHanded = e.target.checked; applyControls(); save(); flashHints(2500);
});
for (const b of document.querySelectorAll('[data-dirs]')) {
  b.addEventListener('click', () => { settings.eightWay = b.dataset.dirs === '8'; applyControls(); save(); });
}
$('dpadSize').addEventListener('input', (e) => { settings.dpadSize = +e.target.value; applyControls(); save(); });
$('haptics').addEventListener('change', (e) => {
  settings.haptics = e.target.checked; applyControls(); save();
  if (settings.haptics && navigator.vibrate) navigator.vibrate(15);
});
$('hints').addEventListener('change', (e) => {
  settings.hints = e.target.checked; save();
  if (settings.hints) flashHints(2500); else document.body.classList.remove('show-hints');
});
$('sound').addEventListener('change', (e) => {
  settings.sound = e.target.checked; save();
  if (settings.sound) audio.start();
  audio.setMuted(!settings.sound || state.menuOpen);
});
$('colorMode').addEventListener('change', (e) => { atari.riot.input.color = e.target.checked; });
$('diff0').addEventListener('change', (e) => { atari.riot.input.diff0 = e.target.checked; });
$('diff1').addEventListener('change', (e) => { atari.riot.input.diff1 = e.target.checked; });
$('powerBtn').addEventListener('click', () => { if (atari.cart) { atari.reset(); windowTracker.reset(); closeMenu(); } });

// Console switches: held while pressed, but never shorter than a few frames.
function holdButton(el, key) {
  let downAt = 0, timer = 0;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    downAt = performance.now();
    input[key] = true;
    el.classList.add('held');
  });
  const release = () => {
    if (!input[key]) return;
    const left = MIN_BUTTON_MS - (performance.now() - downAt);
    const off = () => { input[key] = false; el.classList.remove('held'); };
    if (left > 0) timer = setTimeout(off, left); else off();
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}
holdButton($('selectBtn'), 'uiSelect');
holdButton($('resetBtn'), 'uiReset');

touch.onTouch = () => {
  if (document.body.classList.contains('show-hints')) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), 600);
  }
};

// ---------------------------------------------------------------- display

// Safe-area insets in px, measured from a probe that uses env().
const probe = document.createElement('div');
probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
  'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
document.body.appendChild(probe);

function layout2D() {
  const c = $('screen2d');
  const ps = getComputedStyle(probe);
  const sl = parseFloat(ps.paddingLeft) || 0, sr = parseFloat(ps.paddingRight) || 0;
  const st = parseFloat(ps.paddingTop) || 0, sb = parseFloat(ps.paddingBottom) || 0;
  const W = window.innerWidth, H = window.innerHeight;
  const pad = 10;
  const aspect = 160 / (windowTracker.win.height * LY);
  const portrait = H > W;
  // Portrait: the bar sits on top and the lower part of the screen stays free for
  // thumbs. Landscape: the bar is a column on the right and the game gets full height.
  const barH = portrait ? $('bar').offsetHeight : 0;
  const railW = portrait ? 0 : $('bar').offsetWidth - sr;
  const availW = W - sl - sr - railW - pad * 2;
  const availH = portrait ? (H - barH - sb) * 0.6 : H - st - sb - pad * 2;
  const w = Math.max(80, Math.min(availW, availH * aspect));
  const h = w / aspect;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.style.left = `${sl + pad + (availW - w) / 2}px`;
  c.style.top = `${portrait ? barH + 4 : st + pad + (availH - h) / 2}px`;
}
window.addEventListener('resize', layout2D);
window.addEventListener('orientationchange', () => setTimeout(layout2D, 200));

// ---------------------------------------------------------------- loop

let acc = 0, lastTime = performance.now(), lastHeight = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  const running = atari.cart && !state.menuOpen && !document.hidden;

  if (running) {
    acc += dt;
    let ran = 0;
    while (acc >= FRAME_TIME && ran < 4) {
      input.update();
      atari.runFrame();
      acc -= FRAME_TIME;
      ran++;
    }
    if (ran === 4) acc = 0;
    if (ran) {
      const f = atari.tia.front;
      const win = windowTracker.update(f);
      if (win.height !== lastHeight) { lastHeight = win.height; layout2D(); }
      screen2d.draw(f, win);
    }
  } else {
    acc = 0;
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- boot

(async () => {
  syncMenu();
  audio.setMuted(!settings.sound);
  library.migrate();
  const lastId = library.lastId();
  const last = lastId && lastId !== DEMO_ID ? library.entry(lastId) : null;
  const bytes = last && library.get(last.id);
  try {
    await withLoading(bytes ? last.name : 'Demo cart', async () => {
      if (bytes) loadRom(bytes, last.name, last.id);
      else await loadDemoNow();
    });
  } catch (err) {
    toast(`Couldn't load the demo: ${err.message}`);
  }
  layout2D();
  flashHints(0);
  requestAnimationFrame(tick);
})();

window.atari = atari;
window.touch = touch;
window.input = input;
