# 2600Touch

A touch-first Atari 2600 emulator for phones. Plain HTML, CSS and JavaScript modules,
with no dependencies and no build step.

## Controls

- **Left half: joystick.** A d-pad appears wherever your thumb lands. Direction comes
  from which way you drag from that spot, even past the d-pad's rim, so you can slide
  from one direction to another without returning to center.
- **Right half: fire.** Any touch fires. Quick taps are held for at least 70 ms so the
  game never misses them.
- Both halves can be used at once. **Left-handed** mode in settings swaps them.
- **Select / Reset** sit in the top bar in portrait, and in a column on the right in
  landscape. Most games need Reset to start.
- Bluetooth keyboards and gamepads also work (arrows/WASD, Space; 1 = Select, 2 = Reset).

## Settings (⚙)

- **Cartridges:** add a `.a26`, `.bin` or `.zip`. Every cart you add is kept in a local
  collection in `localStorage`, de-duplicated by content. Tap one to play it; removing
  takes two taps. The last cart played resumes on launch.
- **Controls:** left-handed, 8-way or 4-way joystick, d-pad size, vibrate on fire
  (Android only; Safari has no vibration API), zone hints.
- **Sound** and the console switches (color/B&W, difficulty, power cycle).

Settings open full screen. The game pauses and the touch controls are ignored while
settings are open, and the game also pauses when the app is in the background.

## Run

```bash
npm start     # http://localhost:2601
```

To try it on a phone, serve it on your local network (e.g. `python3 -m http.server 2601
--bind 0.0.0.0`) and open `http://<your-computer's-ip>:2601`. It can be added to the home
screen, where it runs fullscreen.

## Layout

- `src/emu/`: the emulator. 6502 CPU (incl. decimal mode and illegal opcodes), TIA
  video/audio, RIOT, and cartridge mappers (2K, 4K, F8, F6, F4, FA, Superchip, E0, E7, 3F).
- `src/main.js`: app wiring, menu, layout and the frame loop.
- `src/touch.js`: the gesture controls.
- `src/library.js`: the cartridge collection.
- `src/shared.js`: ROM file reading (incl. zip/gz via `src/unzip.js`), loading modal, toast.
- `roms/demo.asm`: a homebrew demo cart, built with `npm run build:demo` (needs `dasm`).
- `tools/render-frame.mjs`: runs a ROM headlessly and writes PNGs of the frame and its
  object layers (`node tools/render-frame.mjs game.a26 300 out/game`).

## Known gaps

- Not yet supported: FE (Activision 8K), DPC (Pitfall II), and other rarer mappers.
- TIA simplifications: HMOVE applies instantly, and late-HMOVE tricks aren't modeled.
- PAL games use the NTSC palette.
