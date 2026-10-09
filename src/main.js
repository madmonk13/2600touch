import { Atari2600 } from './emu/atari.js';
import { Screen2D } from './render/screen2d.js';
import { Input } from './input.js';
import { AudioOut } from './audio-out.js';
import { store, readRomFile, fetchRom, withLoading, toast, WindowTracker } from './shared.js';
import { library, renderLibrary, DEMO_ID } from './library.js';
import { TouchControls } from './touch.js';
import { encode, decode } from './emu/state.js';

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
  volume: 70,        // percent
  resume: true,      // pick games up where they were left
  controller: {},    // romId → 'paddle' | 'joystick', when chosen in settings
  detected: {},      // romId → { paddle, index } from the paddle check
};

const atari = new Atari2600();
const input = new Input(atari);
const audio = new AudioOut(atari.tia.audio);
const screen2d = new Screen2D($('screen2d'));
const windowTracker = new WindowTracker();
const touch = new TouchControls({
  surface: $('surface'), dpad: $('dpad'), ripples: $('ripples'),
  buttons: [$('menuBtn'), $('pauseBtn'), $('cartBtn'), $('selectBtn'), $('resetBtn')],
});
input.sources.push(touch);

const settings = { ...DEFAULTS, ...(store.get('mobile') || {}) };
settings.controller = { ...settings.controller };
settings.detected = { ...settings.detected };
// Carry over the earlier per-cart paddle list.
for (const id of Object.keys(settings.paddleCarts || {})) settings.controller[id] = 'paddle';
delete settings.paddleCarts;
const state = { romId: null, menuOpen: false, paused: false };

// Block page-level zoom/scroll gestures; this is a full-screen app.
for (const ev of ['gesturestart', 'gesturechange', 'dblclick']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.sheet')) e.preventDefault();
}, { passive: false });

// ---------------------------------------------------------------- audio

// iOS only (re)starts audio inside a user gesture, and only some events count
// (touchend and click, not always pointer events whose default was prevented),
// so try on all of them. Capture phase so nothing can stop them first.
const unlockAudio = () => { if (settings.sound) audio.start(); };
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
  window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}
// Coming back from the background often leaves audio suspended or interrupted.
document.addEventListener('visibilitychange', () => { if (!document.hidden && settings.sound) audio.resume(); });

// ---------------------------------------------------------------- ROMs

// Work out once per cart whether it's a paddle game (see detect-worker.js), and
// switch to paddle controls if so, unless the player has picked a controller.
let detector = null;
function detectController(id, bytes) {
  if (settings.detected[id]) return;
  if (!detector) {
    try { detector = new Worker(new URL('./detect-worker.js', import.meta.url), { type: 'module' }); } catch { return; }
    detector.onmessage = ({ data: { id: doneId, paddle, index } }) => {
      settings.detected[doneId] = paddle ? { paddle, index } : { paddle };
      save();
      if (doneId !== state.romId || settings.controller[doneId] || !paddle) return;
      applyControls();
      toast('Paddle game detected. Change the controller in Settings.', { info: true });
    };
  }
  detector.postMessage({ id, bytes: bytes.slice() });
}

// ---------------------------------------------------------------- resume

// The game in progress is saved when the page is hidden or closed, and every
// few seconds while playing, so a refresh or relaunch picks up where it was.
const RESUME = 'resume:';
const RESUME_VERSION = 1;              // bump when saved state stops being compatible
const RESUME_EVERY_MS = 5000;

function saveResume() {
  if (!atari.cart || !settings.resume || !state.romId) return;
  store.trySet(RESUME + state.romId, encode({
    v: RESUME_VERSION, mapper: atari.cart.name, state: atari.saveState(), paddlePos: input.paddlePos,
  }));
}

function restoreResume(id) {
  if (!settings.resume) return;
  const text = store.getRaw(RESUME + id);
  if (!text) return;
  try {
    const saved = decode(text);
    if (saved.v !== RESUME_VERSION || saved.mapper !== atari.cart.name) throw new Error('stale');
    atari.loadState(saved.state);
    input.paddlePos = saved.paddlePos ?? 0.5;
  } catch {
    store.remove(RESUME + id);           // unreadable or from an older version: start fresh
    atari.reset();
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) saveResume(); });
window.addEventListener('pagehide', saveResume);

// Load a cart into the console and record it in the collection.
function loadRom(bytes, name, id) {
  if (state.paused) setPaused(false);
  saveResume();                          // keep the game being left
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
  input.paddlePos = 0.5;
  restoreResume(id);
  applyControls();
  detectController(id, bytes);
  if (saved) library.setLast(id);
  refreshLibrary();
}

function refreshLibrary() {
  renderLibrary($('library'), {
    currentId: state.romId,
    onPlay: (entry) => playEntry(entry),
    onRemove: (entry) => {
      library.remove(entry.id);
      store.remove(RESUME + entry.id);
      delete settings.controller[entry.id];
      delete settings.detected[entry.id];
      save();
      refreshLibrary();
    },
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
  loadRom(await fetchRom('roms/demo.bin'), 'Snake', DEMO_ID);
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

// Settings and the cartridge list are full-screen takeovers. The game pauses and
// the touch controls go inert while either is open.
const SHEETS = { menu: 'closeMenu', cartsMenu: 'closeCarts' }; // backdrop id → close button id

function openSheet(id) {
  for (const other of Object.keys(SHEETS)) $(other).hidden = other !== id;
  state.menuOpen = true;
  touch.releaseAll();
  touch.enabled = false;
  audio.setMuted(true);
}
function closeMenu() {
  state.menuOpen = false;
  touch.enabled = !state.paused;
  audio.setMuted(!settings.sound || state.paused);
  for (const id of Object.keys(SHEETS)) $(id).hidden = true;
}
// Open on release rather than 'click': mobile browsers can drop the click when
// the finger shifts slightly or another finger is already on the screen.
// Pause: stops the game (and its sound) until resumed from the bar button,
// the veil over the game, or P on a keyboard. The game is saved for resume.
function setPaused(paused) {
  state.paused = paused;
  document.body.classList.toggle('paused', paused);
  $('paused').hidden = !paused;
  $('pauseBtn').setAttribute('aria-pressed', String(paused));
  $('pauseBtn').setAttribute('aria-label', paused ? 'Resume' : 'Pause');
  if (paused) { touch.releaseAll(); saveResume(); }
  touch.enabled = !paused && !state.menuOpen;
  audio.setMuted(paused || state.menuOpen || !settings.sound);
}
$('pauseBtn').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(!state.paused); });
$('pauseBtn').addEventListener('click', (e) => { if (e.detail === 0) setPaused(!state.paused); }); // keyboard
$('paused').addEventListener('pointerup', (e) => { e.preventDefault(); setPaused(false); });
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyP' || e.metaKey || e.ctrlKey || e.altKey || state.menuOpen) return;
  e.preventDefault();
  setPaused(!state.paused);
});

for (const [btn, sheet] of [['menuBtn', 'menu'], ['cartBtn', 'cartsMenu']]) {
  $(btn).addEventListener('pointerup', (e) => { e.preventDefault(); openSheet(sheet); });
  $(btn).addEventListener('click', (e) => { if (e.detail === 0) openSheet(sheet); }); // keyboard
}
for (const [sheet, close] of Object.entries(SHEETS)) {
  $(close).addEventListener('click', closeMenu);
  // After rotating, iOS can hit-test a full-screen sheet against its old layout,
  // so the close button (which moves) stops getting taps. Judge by position instead.
  $(sheet).addEventListener('pointerup', (e) => {
    const r = $(close).getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) closeMenu();
  });
}

function save() { store.set('mobile', settings); }

function applyControls() {
  document.body.classList.toggle('lefty', settings.leftHanded);
  touch.leftHanded = settings.leftHanded;
  touch.eightWay = settings.eightWay;
  // Controller per cart: the player's choice if they made one, else what the
  // paddle check found.
  const chosen = settings.controller[state.romId], found = settings.detected[state.romId];
  const paddle = chosen ? chosen === 'paddle' : !!(found && found.paddle);
  touch.paddle = paddle;
  input.paddleMode = paddle;
  input.paddleIndex = (found && found.index) || 0;
  document.body.classList.toggle('paddle', paddle);
  $('joyHintTitle').textContent = paddle ? 'Paddle' : 'Move';
  $('joyHintText').textContent = paddle ? 'Drag left or right on this side' : 'Touch & drag on this side';
  touch.haptics = settings.haptics;
  touch.setSize(settings.dpadSize);
  $('dpadSizeVal').textContent = `${settings.dpadSize}px`;
  const ctrl = paddle ? 'paddle' : settings.eightWay ? '8' : '4';
  for (const b of document.querySelectorAll('[data-ctrl]')) b.classList.toggle('active', b.dataset.ctrl === ctrl);
}

function syncMenu() {
  $('leftHanded').checked = settings.leftHanded;
  $('dpadSize').value = settings.dpadSize;
  $('haptics').checked = settings.haptics;
  $('hints').checked = settings.hints;
  $('sound').checked = settings.sound;
  $('volume').value = settings.volume;
  $('resume').checked = settings.resume;
  applySound();
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
for (const b of document.querySelectorAll('[data-ctrl]')) {
  b.addEventListener('click', () => {
    const c = b.dataset.ctrl;
    settings.controller[state.romId] = c === 'paddle' ? 'paddle' : 'joystick';
    if (c !== 'paddle') settings.eightWay = c === '8';
    applyControls(); save();
  });
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
function applySound() {
  audio.setVolume(settings.volume / 100);
  $('volumeVal').textContent = `${settings.volume}%`;
  $('volume').disabled = !settings.sound;
}
$('sound').addEventListener('change', (e) => {
  settings.sound = e.target.checked; save();
  if (settings.sound) audio.start();
  audio.setMuted(!settings.sound || state.menuOpen);
  applySound();
});
$('volume').addEventListener('input', (e) => { settings.volume = +e.target.value; applySound(); save(); });
$('volume').addEventListener('change', () => audio.preview());
$('colorMode').addEventListener('change', (e) => { atari.riot.input.color = e.target.checked; });
$('diff0').addEventListener('change', (e) => { atari.riot.input.diff0 = e.target.checked; });
$('diff1').addEventListener('change', (e) => { atari.riot.input.diff1 = e.target.checked; });
$('powerBtn').addEventListener('click', () => {
  if (!atari.cart) return;
  store.remove(RESUME + state.romId);
  atari.reset(); windowTracker.reset(); closeMenu();
});
$('resume').addEventListener('change', (e) => {
  settings.resume = e.target.checked; save();
  if (settings.resume) saveResume(); else if (state.romId) store.remove(RESUME + state.romId);
});

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

// The touch-zone hints fade once the player starts playing, whether by touch,
// mouse, keyboard or gamepad.
function dismissHints() {
  if (document.body.classList.contains('show-hints')) {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.remove('show-hints'), 600);
  }
}
touch.onTouch = dismissHints;
input.onActivity = dismissHints;

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
  const barH = $('bar').offsetHeight;
  const availW = W - sl - sr - pad * 2;
  const portrait = H > W;
  // Portrait sits below the bar and keeps the lower part of the screen free for
  // thumbs. Landscape uses the full height, running up behind the bar.
  const availH = portrait ? (H - barH - sb) * 0.6 : H - st - sb;
  const w = Math.max(80, Math.min(availW, availH * aspect));
  const h = w / aspect;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  c.style.left = `${sl + pad + (availW - w) / 2}px`;
  c.style.top = `${portrait ? barH + 4 : st + (availH - h) / 2}px`;
}
// Rotating can leave iOS with the page scrolled or zoomed a little, which shifts
// where taps land relative to what's drawn. Snap back after every resize, and
// again once the rotation animation has settled.
function onViewportChange() {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  if (state.menuOpen && innerWidth > innerHeight) document.querySelector('.settings-sheet').scrollTop = 0;
  layout2D();
}
let settleTimer = 0;
function onRotate() {
  onViewportChange();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(onViewportChange, 350);
}
window.addEventListener('resize', onRotate);
window.addEventListener('orientationchange', onRotate);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onRotate);

// ---------------------------------------------------------------- loop

let acc = 0, lastTime = performance.now(), lastHeight = 0, lastSave = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  const running = atari.cart && !state.menuOpen && !state.paused && !document.hidden;
  // The pause button only means something with a game loaded.
  const pauseBtn = $('pauseBtn');
  if (pauseBtn.disabled === !!atari.cart) pauseBtn.disabled = !atari.cart;

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
    audio.flush();
    if (ran) {
      const f = atari.tia.front;
      const win = windowTracker.update(f);
      if (win.height !== lastHeight) { lastHeight = win.height; layout2D(); }
      screen2d.draw(f, win);
    }
    if (now - lastSave > RESUME_EVERY_MS) { lastSave = now; saveResume(); }
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
    await withLoading(bytes ? last.name : 'Snake', async () => {
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
window.audio = audio;
