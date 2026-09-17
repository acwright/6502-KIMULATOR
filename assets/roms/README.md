# Bundled ROMs

Two images, both build artifacts of other repositories. **They are never edited
here.** When either changes upstream, re-copy it, update the table below, and
re-run the tests.

Each ships twice, because two builds load it from two places:

| Path | Loaded by |
|---|---|
| `assets/roms/` | Electron and the CLI, via `extraResources` |
| `src/renderer/public/roms/` | the web build, fetched from `BASE_URL + roms/…` |

The copies must stay byte-identical; `BundledROM.test.ts` (phase 1) is what
holds them to it. Updating one and not the other ships a desktop app running a
different ROM from the browser build, and every test would go on passing.

## BIOS.bin — 32 KB

The family's BIOS. Spans `$8000–$FFFF` as an image, but only `$A000–$BFFF` of it
is visible on a KIM: the Kernal at `$A000–$B7FF` and the CP437 character set at
`$B800–$BFFF`. The Keypad Card overlays everything above.

- **Source** — `/Users/acwright/Developer/Assembly/6502-BIOS`, `BIOS.bin` on
  branch `v1.x`, not the repository's `main`, which is BIOS 2.x. The commit
  below is "Lower RTS as BASIC reads the input buffer", the 1.6 rebuild that
  the `v1.6` tag is due to move to; it was first taken at `71e1e66`
  (sha256 `fc0002d0…`)
- **Commit** — `27bd4e08acd9a172101b388a981efb26c33dead2` (2026-09-17)
- **Version string** — `6502 BIOS v1.6`
- **SHA-256** — `4ec29214248089642cc399273491bd02481536639db38f40d6f2e4af1fd4d312`

On a KIM, 1.6 changes only what `KernalVersion` reports. Its NVRAM save slots
need an RTC card, which a KIM doesn't have, so every `Nv*` entry returns carry
set.

**The KIM stays on BIOS 1.x.** Future updates come only from 6502-BIOS `v1.x`,
as 1.6.x. `BundledROM.test.ts` refuses any other version string.

## KCMonitor.bin — 8 KB

The Keypad Card's own ROM: an AT28C64 at `$E000–$FFF9`, carrying the KC Monitor
and the CPU vectors at `$FFFA–$FFFF`. This is what the machine boots into, and
it is the reason a KIM is a KIM rather than an ACE with no video card.

Renamed on the way in — upstream it is `KC Monitor.bin`, with a space, which is
awkward in a URL the web build has to fetch.

- **Source** — `/Users/acwright/Developer/Kicad/6502-KIM`,
  `Firmware/KC Monitor/KC Monitor.bin`
- **Commit** — `3b5aa805085d55ef3d1a3291c635ce97485b49ad` (2026-09-02)
- **Version string** — `KIM MONITOR v1.0`
- **SHA-256** — `06601fb6d962b01266988e6a78a962cad03392c6850d1a510455193c8db40aaf`

### Serial `R` is a call in this build

`XXXX R` is a `JSR` through `XAML`, not original Wozmon's `JMP (XAML)`. A
program that ends in `RTS` now returns to the parser and gets a fresh `> `
prompt, matching the pad's `▲`, which has always run the program under the
cursor as a subroutine.

Before this build an `RTS` left the terminal with no prompt *and* a line buffer
still holding the `XXXX R` that launched it, so the next line typed was appended
to that line and re-ran the program rather than being parsed. Anything that
drove the serial monitor and worked around that — expecting a run to time out,
or ending every program in `STP` — still works; `STP` still halts the machine.

### The splash gate changed in the previous build

Worth knowing, because it is the first thing anything driving this machine
runs into. Both consoles now show `--ESC TO START--` and both mean it:

- **`ESC` is the only key that starts the monitor.** The pad used to open the
  gate on any key. It no longer does — `RIGHT` leaves you on the splash.
- **The serial `> ` prompt appears only after the gate opens.** It used to go
  out ahead of it, in front of a parser that was not running yet, so anything
  typed at it either vanished or executed later depending on how the splash
  was dismissed. Waiting on `>` to decide the machine is ready now deadlocks
  if the `ESC` that opens the gate is what you were holding back — wait on
  `ESC TO START` instead.
- **One `ESC` starts both consoles**, from either source, and the gate
  discards everything typed or pressed at the splash on the way through.
