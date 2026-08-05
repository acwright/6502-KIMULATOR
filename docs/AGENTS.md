# Working notes for 6502-KIMULATOR

Read this before changing anything here. It is the short version of
[../PLAN.md](../PLAN.md) — what the machine is, where the code comes from, and
the conventions the repository is held to.

> The user-facing guide — *driving the emulator from an agent*, the direct
> descendant of `6502-EMULATOR/docs/AGENTS.md` — lands with the CLI in phase 7.
> It documents commands, and there are none yet. Do not write it early.
>
> [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) is the reference for the JSON-RPC
> service, and is current as of phase 3. The service can be driven over HTTP
> today; the `6502-kim dbg` client it describes arrives with phase 7.

---

## The machine in one screen

A **KIM** as it is actually built: a 65C02, 32 KB of RAM, the family BIOS, a
Serial Card, and a **Keypad Card** that overlays the top of the address space
with its own PIA, its own 8 KB ROM and its own vectors. It boots into the **KC
Monitor**.

```
$0000–$7FFF   RAM                     32 KB SRAM
$8000–$9FFF   I/O slots               eight 1 KB windows
$A000–$B7FF   BIOS Kernal             from BIOS.bin, still callable
$B800–$BFFF   CP437 character set     from BIOS.bin, still readable
$C000–$DFFF   PIA (65C21)             mirrored every 4 bytes — A0=RS0, A1=RS1
$E000–$FFF9   Keypad Card ROM         AT28C64, 8 KB — KC Monitor
$FFFA–$FFFF   CPU vectors             the Keypad Card's own
```

The Keypad Card overlays the map, so **it is decoded before ROM**. Of the eight
slots only two are ever filled: `io5` (`$9000`) holds the ACIA, and `io6`
(`$9400`) is the accessory bus. The rest are `Empty`, deliberately.

**There is no cartridge slot.** The Keypad Card *is* the cartridge, and it is
soldered into this emulator's identity. "Load Cart" does not exist in any
surface — not the control bar, not a CLI flag, not an embed parameter, not the
vocabulary.

## What this is not

The KIM is not an ACE with a keypad bolted on. **Do not port** the ACE-only
hardware, however tempting the file is sitting there in the sibling repo:

video (TMS9918 / F18A) · sound (SID) · storage (CompactFlash) · RTC / NVRAM
(DS1511Y+) · RAM banks · joysticks · the matrix keyboard · BASIC.

The `IO` interface and `SlotConfig` come across intact, so a card omitted today
can be fitted later without reworking the bus. What does not come across is the
*card*, its UI, its settings, its tests, and its persistence.

## Where the code comes from

| Source | What it settles |
|---|---|
| `../6502-EMULATOR` | Architecture, the CPU, the ACIA, `debug/`, the CLI, the Electron shell, the theme. The port's origin. |
| `6502-EMULATOR@d8b7882` | `LCDAttachment.ts` and `KeypadAttachment.ts` only. **Nothing else at that commit is trusted.** |
| `docs/reference/lcd-reference.png` | The LCD panel's visual specification. The renderer it records no longer exists anywhere; this image is all there is. Do not delete it. |
| `../../Kicad/6502-KIM` | The hardware. `README.md` for the overlay map and the PIA pinout; `Firmware/KC Monitor/` for the ROM and `KC Monitor.asm`. |
| `../../Assembly/6502-BIOS` | `BIOS.bin`, and `Kernal.asm` / `BIOS.inc` for `KernalInit`, the slot probes and `HW_PRESENT`. |
| `../6502-DOCS` | `docs/reference/keypad-map.md` — the 24 keycodes. `docs/addons/kim.md`. The LED type-in cards. |
| `../../Kicad/KIM Demo` | The LED accessory circuit. |
| `../bin2woz` | The upload format the Paste box has to accept. |

## Principles

**Port, don't rewrite.** Where 6502-EMULATOR already solves a problem, the file
comes over as-is — same names, same structure, same comments. Divergence has to
earn itself.

**No shared library.** The two emulators are separate repositories with
duplicated cores, deliberately. A fix in one is carried to the other by hand.

**The BIOS is upstream.** `BIOS.bin` and `KCMonitor.bin` are build artifacts
copied in and never edited here. See [../assets/roms/README.md](../assets/roms/README.md)
for the commit each was taken from; `BundledROM.test.ts` holds the two copies of
each to that record.

**Hardware behaviour, not convenient behaviour.** The keypad encoder ignores key
releases because the 74C922 does. The LED latch reads back open bus because a
74HC373 has no read strobe — and that is what keeps the BIOS's `ProbeGPIO` from
mistaking it for a VIA.

**Tests come with the code.** Every ported module brings its test file. Every new
device ships with one. CI runs the suite, the typecheck, and the worked examples
on every push.

**One commit per task, one tag per release.** Conventional, imperative subject
lines. A phase ends with its tests green and its work committed.

## Layout

```
src/core/          the machine — CPU, RAM, ROM, IO cards, attachments
src/debug/         session, scheduler, disassembler, snapshots, the debug server
src/main/          Electron main process
src/preload/       the contextBridge
src/renderer/src/  the Vue app — panels, stores, composables
src/shared/        types crossing the main/renderer boundary
src/cli/           the 6502-kim command line
src/host/headless/ the windowless host the CLI drives
src/tests/         everything, mirroring the tree above
assets/roms/       ROMs for Electron and the CLI (extraResources)
src/renderer/public/roms/   the same ROMs for the web build
docs/reference/    source material — see lcd-reference.png
docs/DEBUG-PROTOCOL.md      the JSON-RPC service, method by method
```

Path aliases, in every config: `@core`, `@debug`, `@shared`, `@renderer`, and
`@` for `src/renderer/src`.

## Running it

```sh
npm ci
npm run typecheck        # vue-tsc over the renderer + tsc over main
npm test                 # jest, with coverage, over core/debug/host
npm run dev              # electron-vite — the desktop app          (phase 4)
npm run build:web        # static site into dist/web                (phase 8)
npm run icons            # regenerate every icon format from build/6502.png
npm run build:cli        # tsc -p tsconfig.cli.json                 (phase 7)
```

`npm run icons` needs ImageMagick 7 (`magick`) and macOS `iconutil`/`sips`. The
generated `icon.icns`, `icon.ico`, `icon.png` and `icon.iconset/` are tracked, so
CI never has to run it.

## Phase status

Phases are [../PLAN.md](../PLAN.md); this is where the work has reached.

- [x] **0** — repository, toolchain, icon, CI
- [x] **1** — core port
- [x] **2** — the Keypad Card
- [x] **3** — debug core & protocol
- [ ] **4** — Electron shell
- [ ] **5** — the interface
- [ ] **6** — accessories
- [ ] **7** — command line
- [ ] **8** — web build & embed
- [ ] **9** — README, LICENSE & examples
- [ ] **10** — release v1.0.0

`src/renderer/src/App.vue` is a scaffold: it draws the four regions of the
finished layout with their names in them, so `npm run dev` shows the shape of
the machine. Phase 5 fills them in.

`src/core/Machine.ts` is the KIM's own, written rather than ported: the ACE's
decode order is different enough that bringing it across would only have been
undone. The Keypad Card is not in a slot and not optional — `pia`, `keypad`,
`lcd` and `cardROM` are plain fields, there is no `loadCart` or `unloadCart`,
and the card's two windows are decoded *before* the BIOS ROM. That last line is
the machine's identity; if a change makes `$E000` read out of `BIOS.bin`, it is
not a KIM any more.

`src/core/KeypadMap.ts` is the only description of the pad. The encoder code is
not the key's value — `0` is `$0A` and `C`–`F` run backwards — so nothing may
derive one from the other arithmetically. `KeypadMap.test.ts` transcribes
6502-DOCS `docs/reference/keypad-map.md` a second time and compares; a test that
imported the map and checked it against itself would pass whatever it said.

`KCMonitor.test.ts` boots the real firmware and drives it from the pad. It is
slow on purpose — `LcdInit` runs the HD44780 power-on ritual with four ~41 ms
software delays in it, so the splash costs ~1.8 M cycles and there is no honest
way to skip them.

`src/debug/` is a lift from 6502-EMULATOR, and almost none of it is
machine-specific — which is exactly why full parity was affordable. What did
have to change is documented in
[DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md#differences-from-6502-emulator); the short
version:

- **Gone with the hardware.** `PNG.ts` and `KeyCodes.ts`, and with them
  `screen.*`, `input.*` and the `vram`/`nvram`/`cf` memory spaces. `adler32`
  went with `PNG.ts` — it existed for the zlib trailer and nothing else.
- **`keypad.press`** replaces the whole `input.*` group, and reads `KeypadMap`
  like everything else. Sequences are paced **one key per execution chunk**: the
  74C922 latches a single code and the CA1 handler's read is what clears it, so
  two presses with no emulated time between them lose the first.
- **`lcd.text` / `lcd.hash` / `lcd.pixels`** stand where `screen.*` did, and are
  never `NOT_SUPPORTED` — the panel is on the Keypad Card, not in a slot.
- **`Snapshot.ts`** carries `pia` (with the keypad and the LCD nested inside it)
  beside `cpu` and `ram`, and the Keypad Card's ROM by **identity**, not content.
  The format string is `6502-kim-snapshot` and the two emulators refuse each
  other's files.
- **The lock file is `~/.6502-kim/session.json`**, `$SIXTY5O2_KIM_HOME`. Sharing
  `~/.6502` would mean whichever emulator started second could not serve, or that
  a client attached to the wrong machine and never found out.
- **`symbols/parse.ts` reads ca65 listings** (`format: 'lst'`). `cl65 -l` is what
  builds `KC Monitor.bin`, and it emits a `.lst` and no `.dbg` — so without this
  the ROM a KIM session spends most of its time in is the one with no symbols. A
  listing counts from a segment start, so `KC_MONITOR_SEGMENTS` supplies the
  bases out of the card's own `6502.cfg`; labels take the location counter,
  equates take their right-hand side, and getting that backwards would put the
  entire Kernal API at `$E000`.

Two things every debug test has to respect, both of them the decode:

**Test programs go at `$A000`, not `$C000`.** On a KIM `$C000` is the PIA,
mirrored every four bytes, so 6502-EMULATOR's habit of assembling a program there
would be writing to a 65C21. `$A000` is the Kernal window, which the card leaves
reachable.

**Reset vectors go in the card ROM.** `$FFFC` of `BIOS.bin` is not on this
machine's bus. Every helper that sets one writes `CardROM` at `$1FFC`, and a test
that starts at `$0000` is telling you the overlay has broken.

`KCMonitorProtocol.test.ts` is phase 3's counterpart to `KCMonitor.test.ts`: it
boots the real firmware and drives it entirely through `createMethods`, because
the exit criterion is not "the monitor moves" — phase 2 settled that — but "a
scripted client can move it and see that it moved."
