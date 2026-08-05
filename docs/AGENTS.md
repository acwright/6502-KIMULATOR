# Working notes for 6502-KIMULATOR

Read this before changing anything here. It is the short version of
[../PLAN.md](../PLAN.md) — what the machine is, where the code comes from, and
the conventions the repository is held to.

> The user-facing guide — *driving the emulator from an agent*, the direct
> descendant of `6502-EMULATOR/docs/AGENTS.md` — lands with the CLI in phase 7.
> It documents commands, and there are none yet. Do not write it early.

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
- [ ] **1** — core port
- [ ] **2** — the Keypad Card
- [ ] **3** — debug core & protocol
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
