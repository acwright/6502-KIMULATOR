# 6502-KIMULATOR — Build Plan

An emulator for the **6502-KIM** — the Keypad Input Monitor member of the AC6502
family. Desktop (Electron), browser, and a command line, ported from
[6502-EMULATOR](https://github.com/acwright/6502-EMULATOR) and wrapped in a UI
built for a keypad, a two-line LCD, and a serial terminal.

---

## Table of Contents

- [What We Are Building](#what-we-are-building)
- [What We Are Not Building](#what-we-are-not-building)
- [Guiding Principles](#guiding-principles)
- [Sources of Truth](#sources-of-truth)
- [The Machine](#the-machine)
- [The Interface](#the-interface)
- [Decisions Taken](#decisions-taken)
- [Phase Overview](#phase-overview)
- [Phase 0 — Repository & Toolchain](#phase-0--repository--toolchain)
- [Phase 1 — Core Port](#phase-1--core-port)
- [Phase 2 — The Keypad Card](#phase-2--the-keypad-card)
- [Phase 3 — Debug Core & Protocol](#phase-3--debug-core--protocol)
- [Phase 4 — Electron Shell](#phase-4--electron-shell)
- [Phase 5 — The Interface](#phase-5--the-interface)
- [Phase 6 — Accessories](#phase-6--accessories)
- [Phase 7 — Command Line](#phase-7--command-line)
- [Phase 8 — Web Build & Embed](#phase-8--web-build--embed)
- [Phase 9 — README, LICENSE & Examples](#phase-9--readme-license--examples)
- [Phase 10 — Release v1.0.0](#phase-10--release-v100)
- [Deferred](#deferred)

---

## What We Are Building

A faithful emulation of a **KIM as it is actually built**: a 65C02, 32 KB of
RAM, 32 KB of BIOS ROM, a Serial Card, and — the thing that makes it a KIM — a
**Keypad Card** that overlays the top of the address space with its own PIA,
its own 8 KB ROM, and its own vectors. It boots into the **KC Monitor**, not
into BASIC.

Three things you can touch, and one you can plug into:

| Panel | What it is |
|---|---|
| **Terminal** | 40×24, white on black. Exactly what the serial port sees, in both directions. New to this emulator — the Serial Card is integral to the KC Monitor experience and the real thing needs a laptop plugged into it. |
| **LCD** | The 16×2 HD44780 on the Keypad LCD Helper, drawn as a real dot-matrix panel. |
| **Keys** | The 24-key pad on the Keypad Helper, laid out and coloured like the real one. |
| **Accessory** | A slot on the bus at `$9400` where a breadboard circuit is wired. First one: eight LEDs behind a 74HC373 latch. |

Everything else that 6502-EMULATOR does — the cycle-accurate CPU, the debug
server, the CLI, the headless host, snapshots, the web build, the embeddable
page — comes across with it.

---

## What We Are Not Building

The KIM is not an ACE with a keypad bolted on, and this emulator must not become
one. **Do not port** the ACE-only hardware:

- **Video** (TMS9918 / F18A) — no video card, no framebuffer, no `VideoCanvas`
- **Sound** (SID) — no audio graph, no `AudioWorklet`, no mute button
- **Storage** (CompactFlash) — no CF image, no disk persistence
- **RTC / NVRAM** (DS1511Y+) — no clock card, no NVRAM file
- **RAM banks** — the Memory Card is 32 K flat
- **Joysticks** and the **matrix keyboard** — the pad is the only input
- **BASIC** — the Keypad Card's ROM replaces it; there is no `.bas` to load

The `IO` interface and `SlotConfig` come across intact, so a card omitted today
can be fitted later without reworking the bus. What does not come across is the
*card*, its UI, its settings, its tests, and its persistence.

---

## Guiding Principles

**Port, don't rewrite.** Where 6502-EMULATOR already solves a problem, the file
comes over as-is — same names, same structure, same comments. Divergence has to
earn itself. The CPU, the ACIA, `DeviceState`, the whole `debug/` tree, the CLI
scaffolding and the Electron plumbing are all lifts.

**No shared library.** The two emulators are separate repositories with
duplicated cores, deliberately. A fix in one is carried to the other by hand,
and that cost is accepted in exchange for each being free to diverge.

**The BIOS is upstream.** `BIOS.bin` and `KC Monitor.bin` are copied in as
build artifacts and never edited here. When they change, we re-copy and re-run
the tests.

**Hardware behaviour, not convenient behaviour.** The keypad encoder ignores
key releases because the 74C922 does. The LED latch reads back open bus because
a 74HC373 has no read strobe — and that is what keeps the BIOS's `ProbeGPIO`
from mistaking it for a VIA.

**Tests come with the code.** Every ported module brings its test file. Every
new device (PIA, keypad, LCD, LED latch) ships with one. CI runs the suite, the
typecheck, and the worked examples on every push.

**One commit per task, one tag per release.** Conventional, imperative subject
lines. A phase ends with its tests green and its work committed.

---

## Sources of Truth

| Source | What it settles |
|---|---|
| `/Users/acwright/Developer/NodeJS/6502-EMULATOR` | Architecture, the CPU, the ACIA, `debug/`, the CLI, the Electron shell, the theme. The port's origin. |
| `6502-EMULATOR@d8b7882` | `LCDAttachment.ts` (HD44780 + A00 font + pixel buffer) and `KeypadAttachment.ts` (74C922 encoder). Bring these forward. **Nothing else at that commit is trusted.** |
| `docs/reference/lcd-reference.png` | The one surviving screenshot of the old LCD renderer. **The panel's visual specification** — see [The LCD panel](#the-lcd-panel). The renderer itself no longer exists (see below); this image is all there is. |
| `/Users/acwright/Developer/Kicad/6502-KIM` | The hardware. `README.md` for the overlay map and the PIA pinout; `Firmware/KC Monitor/` for the ROM, its `README.md`, and `KC Monitor.asm` when behaviour is in question. |
| `/Users/acwright/Developer/Assembly/6502-BIOS` | `BIOS.bin`, and `Kernal.asm` / `BIOS.inc` for `KernalInit`, the slot probes and `HW_PRESENT`. |
| `/Users/acwright/Developer/NodeJS/6502-DOCS` | `docs/reference/keypad-map.md` — the pad layout and all 24 keycodes. `docs/addons/kim.md` — how the monitor is used. `docs/public/cards/archive/kim-led-*.html` — the LED programs, and the `$9400` latch. |
| `/Users/acwright/Developer/Kicad/KIM Demo` | The LED accessory circuit. |
| `/Users/acwright/Developer/NodeJS/bin2woz` | The upload format the Paste box has to accept. |

### On the lost renderer

The old LCD **renderer** is gone, and searching has confirmed it rather than
found it: there are no `.vue` or `.html` files anywhere in 6502-EMULATOR's
history before the Electron refactor, `d8b7882` and its neighbours are
core-only, `git fsck` turns up no dangling object carrying one, the
`Graveyard/6502 Emulator.zip` `LCDCard.vue` is a 44-byte
`<div>LCD Card</div>` stub, and nothing named `*lcd*` exists on disk outside
the KiCad hardware.

What survives from that work is the half that matters most and is hardest to
rewrite: `LCDAttachment.ts`, the HD44780 controller with the A00 font, which
emits the pixel buffer. The drawing on top of it was a few hundred lines of
canvas work and is reconstructed from the screenshot in Phase 5.

---

## The Machine

### Cards fitted

The canonical build is Backplane + CPU Card + Memory Card + Serial Card +
Keypad Card. In `SlotConfig` terms:

| Slot | Window | Fitted |
|---|---|---|
| `io1` | `$8000–$83FF` | `Empty` — no RAM bank |
| `io2` | `$8400–$87FF` | `Empty` — no RAM bank |
| `io3` | `$8800–$8BFF` | `Empty` — no RTC |
| `io4` | `$8C00–$8FFF` | `Empty` — no storage |
| `io5` | `$9000–$93FF` | `ACIA` — Serial Card (**toggleable**; `Empty` when unfitted) |
| `io6` | `$9400–$97FF` | **Accessory bus** — `Empty`, or the selected accessory |
| `io7` | `$9800–$9BFF` | `Empty` — no SID |
| `io8` | `$9C00–$9FFF` | `Empty` — no video |

The Serial Card toggle is not decoration: `KC Monitor.asm` guards every ACIA
access on `HW_PRESENT & HW_SC`, so unfitting it is the only way to exercise the
keypad-only path the firmware explicitly supports.

### Decode order

The Keypad Card overlays the top of the map, so it is tested **before** ROM:

```
$0000–$7FFF   RAM                     32 KB SRAM
$8000–$9FFF   I/O slots               eight 1 KB windows, above
$A000–$B7FF   BIOS Kernal             from BIOS.bin, still callable
$B800–$BFFF   CP437 character set     from BIOS.bin, still readable
$C000–$DFFF   PIA (65C21)             mirrored every 4 bytes — A0=RS0, A1=RS1
$E000–$FFF9   Keypad Card ROM         AT28C64, 8 KB — KC Monitor
$FFFA–$FFFF   CPU vectors             the Keypad Card's own
```

`BIOS.bin` remains a 32 KB image spanning `$8000–$FFFF`; only `$A000–$BFFF` of
it is ever visible on a KIM. The Keypad Card's ROM is a separate 8 KB image at
`$E000`, replacing `Cart` from 6502-EMULATOR (which models a 32 KB VCS
cartridge and is the wrong shape here).

### There is no cartridge slot

The Keypad Card **is** the cartridge, and it is soldered into this emulator's
identity. A machine without it is not a KIM — it is an ACE with no video card,
which is 6502-EMULATOR's job.

So "Load Cart" does not exist here, in any surface: not on the control bar, not
as a CLI flag, not as an embed parameter, not in the vocabulary. Offering it
would imply a second slot the machine does not have, and filling it would evict
the card that makes the machine what it is.

What remains loadable:

- **BIOS ROM** — 32 KB, replaceable, exactly as in 6502-EMULATOR. The BIOS is
  upstream and changes; pointing the emulator at a new build is routine.
- **Binaries** — bytes at an address, the type-in cards without the typing.
- **Keypad Card ROM** — the 8 KB image itself, but from **Settings → FILES**,
  labelled *Keypad Card ROM*, not from the toolbar. It is how you test a
  freshly built `KC Monitor.bin` without burning an AT28C64, which matters
  because that firmware is developed in the sibling repo — but it is changing
  the machine's own firmware, not slotting in a cartridge, and it should read
  that way and sit where you have to mean it.

*(That last one is my call rather than yours — say if you would rather the
Keypad Card ROM were fixed to the bundled image entirely.)*

### The PIA (65C21)

| Address | RS1:RS0 | Register |
|---|---|---|
| `$C000` | `00` | `PORTA` / `DDRA` — selected by `CRA` bit 2 |
| `$C001` | `01` | `CRA` |
| `$C002` | `10` | `PORTB` / `DDRB` — selected by `CRB` bit 2 |
| `$C003` | `11` | `CRB` |

- **Port A** — `PA0–PA4` keypad code (input), `PA5` = LCD `RS`, `PA6` = LCD
  `R/W`, `PA7` = LCD `E` (outputs)
- **Port B** — LCD 8-bit data bus, bidirectional
- **CA1** — keypad data-available, interrupt input. Sets `CRA` bit 7; reading
  `PORTA` clears it.
- **CA2** — encoder output-enable, active low, driven as an output from `CRA`
- **IRQ** — asserted while an enabled, unserviced flag is set; surfaces through
  `tick()`'s bit 7, as every other card does

### The keypad

MM74C922 extended to 24 keys with a 74HC00. Scanning, debounce and encoding are
all in hardware — the emulation is a latch, a data-available line, and a lookup.

Press latches the 5-bit code and raises DA. **Releases are ignored.** The code
is only driven onto `PA0–PA4` while `CA2` (OE) is low and data is latched;
otherwise the port floats high.

The pad as it sits, with its encoder codes:

| | | | |
|---|---|---|---|
| `ESC` $10 | `INS` $11 | `PGUP` $12 | `A` $13 |
| `▲` $14 | `DEL` $15 | `PGDN` $16 | `B` $17 |
| `7` $07 | `8` $08 | `9` $09 | `C` $0F |
| `4` $04 | `5` $05 | `6` $06 | `D` $0E |
| `1` $01 | `2` $02 | `3` $03 | `E` $0D |
| `◄` $00 | `0` $0A | `►` $0B | `F` $0C |

The code is not the value. `0` is `$0A`, and `C`–`F` run backwards. The lookup
lives in one module (`KeypadMap`) shared by the UI, the CLI and the tests, so
there is exactly one place that can be wrong.

### The LCD

16×2 HD44780, driven directly by the PIA. Commands latch on the falling edge of
`E`. `LCDAttachment.ts` from `d8b7882` already implements the controller —
DDRAM, CGRAM, the A00 ROM font, entry mode, display shift, cursor and blink —
and emits the pixel buffer the panel is drawn from:

```
width  = cols × (5 + 1) − 1
height = rows × (8 + 1) − 1
value  = −1 no pixel (inter-character gap) | 0 off | 1 on
```

That buffer is the look worth keeping. It comes across nearly unchanged; only
its attachment surface changes, from a 6522 VIA to the 65C21 PIA. How it is
drawn is specified in [The LCD panel](#the-lcd-panel).

### The accessory bus

`io6` (`$9400–$97FF`) is where a breadboard gets wired. Both type-in programs in
the DOCS write to `$9400`, so this is the address that matters.

The first accessory is the **KIM Demo**: eight LEDs behind a 74HC373 latch.
Writes latch and light; **reads return open bus**. That is not a shortcut — a
read-back would pass the BIOS's `ProbeGPIO` DDR test and set `HW_GPIO` on a
machine with no VIA in it.

---

## The Interface

```
┌──────────────────────────────┬───────────────────────┐
│                              │                       │
│                              │         LCD           │
│                              │      16×2 dot         │
│          TERMINAL            │        matrix         │
│        40×24, white          ├───────────────────────┤
│         on black             │                       │
│                              │        KEYS           │
├──────────────────────────────┤       4 × 6           │
│                              │                       │
│         ACCESSORY            │                       │
│                              │                       │
└──────────────────────────────┴───────────────────────┘
│  ROM  BIN │ ▶  ↻  ⏻ │ 1 MHz │ 📋  ⚙                  │
└──────────────────────────────────────────────────────┘
```

Black background, white text, Tailwind, Heroicons — the 6502-EMULATOR theme,
unchanged. The keypad is the exception: **Bebas Neue**, hex keys black on white,
function keys white on black, exactly as the real pad is legended.

### Terminal

A tap on the ACIA byte stream, not a second device. Bytes the machine transmits
are written to the terminal *and* to the host serial port when one is connected;
bytes typed into the terminal are delivered to the machine exactly as bytes
arriving from a real port would be. Connect a real port and both views show the
same traffic, which is what "follows exactly what the serial port sees" means.

40 columns × 24 rows. Handles `CR`, `LF`, `BS` and printable ASCII; anything
else is dropped rather than rendered as a glyph. Scrolls at the bottom. Block
cursor, shown only when the terminal has focus.

### The LCD panel

Reconstructed from `docs/reference/lcd-reference.png`, the only surviving
record of the original. Everything below is read off that image.

**The dot grid is always visible.** This is the whole effect and the thing a
naive renderer gets wrong. Every pixel position in every character cell is
drawn as a dot — unlit ones a shade darker than the backlight, lit ones nearly
black. A panel that draws only the lit pixels reads as green text on green;
this one reads as a *display*, because you can see the matrix it is written on
even where nothing is written.

```
      ┌─────────────────────────────────────────┐
      │   ····· ····· ····· ····· ····· ·····   │   backlight (uniform)
      │   ··█·· ··█·· ····· ··█·· ····· ·····   │   lit pixel  (near-black)
      │   ·███· ·█·█· ····· ·███· ····· ·····   │   unlit dot  (darker green)
      │   ····· ····· ····· ····· ····· ·····   │   gap column (backlight)
      └─────────────────────────────────────────┘
        ↑ generous bezel — the glass, not the text
```

| Element | Treatment |
|---|---|
| Backlight | Uniform warm yellow-green, `#AFC85A`. No gradient, no vignette, no hotspot. |
| Unlit dot | `#8AA33B` — **~78% of the backlight's luminance**. Present in every cell position, including blank characters. |
| Lit pixel | `#101B04` — near-black with an olive cast, never pure black. |
| Dot shape | Square with a very slightly softened corner. Not circular, not a hard pixel. |
| Dot gutter | ~20% of the dot pitch, in backlight colour, between dots within a cell. |
| Character gap | One full dot-pitch of backlight between cells and between rows — this is the `-1` in the pixel buffer, drawn as background. Measured: the cell pitch is **6× the dot pitch**, confirming 5 dots plus a 1-dot gap. |
| Bezel | Generous padding of backlight colour around the whole character area, several dot-pitches wide. The glass extends well past the text. |
| Corners | Softly rounded panel. |

**That 78% is the number to get right.** It was measured, not estimated — over
1,904 blank 6×6 tiles containing no lit pixel, the darkest dot against the
brightest backlight in the same tile averages 0.80 and medians 0.77. It is a
much stronger grid than "a shade darker" suggests, and it is why the matrix
reads so clearly in the reference. Blur in the photograph can only have pulled
the two *together*, so if anything the real contrast was higher still.

**Straight on.** No perspective, no rotation, no glare, no reflection, no
scanlines. The reference photo is angled because it is a photograph; the
angle is not the design. The brightness falling off toward the bottom-right of
the reference is the same artefact — sampling the shadowed end gives `#94AC45`
against `#B0C95B` at the lit end, and the panel itself is uniform.

**On the numbers.** The colours above were sampled from the reference with a
3-means clustering plus percentile analysis, but it is a photograph of a
screen: it carries the camera's white balance, is upscaled 2×, and is blurred
enough that the dot geometry beyond the 6:1 cell-to-dot ratio could not be
recovered. Treat the hex values as a calibrated starting point and the *ratios*
as the specification.

The panel fills its region of the layout, keeping the character area's aspect
ratio, with the dot pitch snapped to whole device pixels so the grid stays
crisp at any size. Double-clicking it expands the LCD to fill the window —
which is exactly the reference screenshot, and the reason that screenshot
exists.

Cursor and blink come from the controller, not the renderer: `LCDAttachment`
already reports them, and they are drawn as lit pixels like anything else.

### Focus

Terminal and keypad are focusable regions. Clicking one gives it the keyboard
and a visible ring; `Tab` cycles. No global mode, nothing to remember, and it
mirrors the machine — the serial port and the pad really are two independent
input paths, and on the real thing you choose by moving your hands.

The keypad, when focused, accepts `0`–`9`, `A`–`F`, the arrow keys, `Esc`,
`Insert`, `Delete`, `PageUp`, `PageDown` and `Enter` (as `▲`). Mouse clicks work
regardless of focus, and both routes converge on the same keycode.

### Control bar

Kept from 6502-EMULATOR: Load ROM, Run/Stop, Reset, Power Cycle, frequency
toggle, Paste, Settings. **Load Program** becomes **Load Binary** (bytes at an
address — there is no BASIC to load a `.prg` into, but keying in a type-in card
by hand is optional, not compulsory). **Dropped:** Load Cart (see above), mute,
joystick indicator.

Paste accepts bin2woz output directly, typed into the terminal at a rate the
ACIA can absorb.

### Settings

Kept: **FILES** (BIOS ROM, Keypad Card ROM, binary), **SERIAL** (port, baud/parity/data/
stop, connect), **DEBUG SERVER**, **COMMAND LINE** (shim install).
New: **MACHINE** (Serial Card fitted, frequency), **ACCESSORY** (which circuit
is wired to `$9400`).
Dropped: **STORAGE**, **JOYSTICK**.

---

## Decisions Taken

| Question | Decision |
|---|---|
| Keyboard between terminal and keypad | **Click-to-focus panels.** Focused panel takes the keyboard and shows a ring; `Tab` cycles. No global mode. |
| CLI name | **`6502-kim`.** Matches the hardware repo, and cannot collide with the `6502` shim 6502-EMULATOR installs. |
| Port scope | **Full parity.** Core, `debug/`, CLI, headless host, web build and embed page all ship in v1.0.0, so the DOCS embed works the day it lands. |
| Icon | Black 6502 on **white**, against 6502-EMULATOR's white-on-black — distinguishable at a glance in the Applications folder. |
| Persistence | None. No CF, no NVRAM; a real KIM loses its RAM when you switch it off. Settings persist; machine state does not. |

---

## Phase Overview

| Phase | Delivers | Exit |
|---|---|---|
| **0** | Repository, toolchain, icon, CI | `npm test` and `npm run typecheck` pass on an empty core |
| **1** | Core port — CPU, RAM, ROM, ACIA, `IO`, `DeviceState` | Full ported test suite green |
| **2** | Keypad Card — PIA, keypad, LCD, `KIMMachine` | Machine boots `KC Monitor.bin`, LCD shows an address |
| **3** | `debug/` — Session, Scheduler, disassembler, snapshots, server | Debug protocol tests green |
| **4** | Electron shell — main, preload, settings, serial | App window opens, machine runs, real port connects |
| **5** | The interface — terminal, LCD, keys, control bar, settings | A program is keyed in on the pad and runs |
| **6** | Accessory bus + LED latch | Both DOCS type-in programs run and light the LEDs |
| **7** | `6502-kim` CLI + headless host | `6502-kim run` and `6502-kim dbg` work from a checkout |
| **8** | Web build + `embed.html` | Browser build boots; embed page hosts a machine |
| **9** | README, LICENSE, worked examples | `examples/run-all.sh` passes in CI |
| **10** | v1.0.0 — commit, tag, build, release | Tagged, built for three platforms, released on GitHub |

---

## Phase 0 — Repository & Toolchain

Stand the project up so every later phase has somewhere to land.

### Tasks

1. `git init`; `.gitignore` from 6502-EMULATOR (add `dist/`, `out/`, `coverage/`,
   `*.tsbuildinfo`).
2. `package.json` — name `6502-kimulator`, version `0.1.0`, `private: true`,
   author and repository fields pointed at `acwright/6502-KIMULATOR`,
   `bin: { "6502-kim": "./bin/6502-kim" }`. Dependencies copied from
   6502-EMULATOR **minus** what the ACE-only cards pulled in; keep `vue`,
   `pinia`, `@heroicons/vue`, `serialport`, `buffer`.
3. TypeScript configs — `tsconfig.json`, `.node`, `.web`, `.core`, `.cli`, with
   the `@core` / `@debug` / `@shared` / `@` path aliases carried over.
4. `electron.vite.config.ts`, `vite.web.config.ts`, `jest.config.cjs`,
   `electron-builder.yml` (appId `com.acwright.kimulator6502`, productName
   `6502 KIMulator`, artifact names `${name}-${version}-…`).
5. Tailwind v4 via `@tailwindcss/vite`; `src/renderer/src/style.css` copied.
   Add the Bebas Neue face as a bundled `@font-face` — no CDN.
6. Icon: black 6502 on white as `build/6502.png`; port `build/gen-icon.mjs`;
   generate `.icns`, `.ico`, `.png`. Port the mac entitlements plists.
7. `.github/workflows/ci.yml` — typecheck, test, worked examples.
   `.github/workflows/deploy.yml` — Pages, from `build:web`.
8. Copy `BIOS.bin` to `src/renderer/public/roms/BIOS.bin` and
   `KC Monitor.bin` to `src/renderer/public/roms/KCMonitor.bin`. Record the
   source commit of each in a short `roms/README.md`.
9. `docs/AGENTS.md` — the working notes for this repo, adapted from
   6502-EMULATOR's.
10. **Commit `docs/reference/lcd-reference.png` in the first commit.** Already in
    place. It is the only surviving record of the original renderer and the
    specification Phase 5 builds against — losing it twice would be careless.

### Exit criteria

- `npm ci && npm run typecheck && npm test` succeeds with an empty core
- `npm run icons` regenerates every icon format
- CI is green on the first push

---

## Phase 1 — Core Port

Everything in `src/core/` that is not KIM-specific, plus its tests.

### Tasks

1. Copy **verbatim**: `CPU.ts`, `RAM.ts`, `ROM.ts`, `IO.ts`, `DeviceState.ts`,
   `IO/ACIA.ts`, `IO/Empty.ts`, `IO/CP437.ts`, `ProgramImage.ts`.
2. Trim `ProgramImage.ts` to `loadBinary` — the BASIC pointer fixup
   (`loadProgramImage`, `applyProgramPointers`) has no meaning without BASIC.
3. Replace `Cart.ts` with `CardROM.ts` — the Keypad Card's ROM, named for what
   it is so the cartridge idea cannot creep back in. `START = $E000`,
   `SIZE = 8192`, `VECTORS = $FFFA`. Loads an 8 KB image; rejects any other
   length.
4. Copy the matching tests: `CPU.test.ts`, `W65C02S.test.ts`, `RAM.test.ts`,
   `ROM.test.ts`, `IO/ACIA.test.ts`, `IO/Empty.test.ts`, `IO/CP437.test.ts`,
   `DeviceState.test.ts`, `BundledROM.test.ts` (re-pointed at both ROMs).
5. Write `CardROM.test.ts`.
6. Leave `Machine.ts` for Phase 2 — the KIM's decode is different enough that
   porting the ACE one first would only be undone.

### Deliverables

`src/core/` with a cycle-accurate 65C02, RAM, ROM, an ACIA, and the Keypad Card
ROM.

### Exit criteria

- The full W65C02S opcode suite passes
- `BundledROM.test.ts` verifies both bundled images by length and checksum
- Coverage on `core/` is no lower than 6502-EMULATOR's

---

## Phase 2 — The Keypad Card

The phase that makes it a KIM.

### Tasks

1. **`src/core/IO/PIA.ts`** — 65C21. Four registers, `DDR`/`PORT` selection via
   `CR` bit 2, `CA1` edge detect into `CRA` bit 7, `CA2` as an output under
   `CRA` bits 3–5, IRQ through `tick()` bit 7, `serialize`/`deserialize`.
2. **`src/core/IO/Attachments/Attachment.ts`** — port the base class, retargeted
   from VIA ports to PIA ports (`readPortA`, `readPortB`, `writePortB`,
   `updateControlLines`, `hasCA1Interrupt`, `clearInterrupts`).
3. **`src/core/IO/Attachments/KeypadAttachment.ts`** — forward-port from
   `d8b7882`. Strip the USB HID table (it moves to `KeypadMap`); the attachment
   takes a 5-bit keycode. Keep the OE/DA/latch behaviour exactly.
4. **`src/core/KeypadMap.ts`** — the 24 keys: code, label, glyph, hex value (or
   none), grid position, and the host `KeyboardEvent.code`s that reach it. One
   table, used by the UI, the CLI and the tests, checked against
   `docs/reference/keypad-map.md`.
5. **`src/core/IO/Attachments/LCDAttachment.ts`** — forward-port from
   `d8b7882` with the A00 font intact. Retarget the control pins to the PIA
   (`RS`=`PA5`, `RW`=`PA6`, `E`=`PA7`, data on Port B); keep the pixel-buffer
   output verbatim. Add `serialize`/`deserialize` (DDRAM, CGRAM, address
   counter, entry mode, display flags) — the original predates `DeviceState`.
6. **`src/core/Machine.ts`** — the KIM machine:
   - slots as tabled above, `SlotConfig` retained
   - decode order: PIA window → Keypad Card ROM → BIOS ROM → RAM → slots
   - `loadROM` (32 KB BIOS) and `loadCardROM` (8 KB Keypad Card); `resetCPU`
     re-reads the card's vectors. **No `loadCart`, no `unloadCart`** — the card
     is not removable, so there is no state in which it is absent.
   - `transmit` / `onReceive` for the ACIA; `onKeypadDown(code)` for the pad;
     `lcd()` accessor for the panel
   - no `render`, no `play`, no `flushAudio`
7. Tests: `PIA.test.ts`, `KeypadAttachment.test.ts` (port and extend the
   `d8b7882` test), `LCDAttachment.test.ts` (likewise), `KeypadMap.test.ts`,
   `Machine.test.ts` (decode order, overlay precedence, slot config).
8. **`KCMonitor.test.ts`** — the integration test. Load both ROMs, run to the
   first LCD refresh, assert the panel shows an address and a byte; key
   `0 8 0 0` and assert the address tracks; enter INS mode, key a byte, assert
   RAM changed.

### Exit criteria

- A machine built from `BIOS.bin` + `KC Monitor.bin` reaches the monitor
- The LCD pixel buffer matches the expected glyphs for a known address
- Keying an address on the pad moves the monitor, nibble at a time
- `HW_PRESENT` after `KernalInit` reads exactly `HW_SC` with the Serial Card
  fitted, and `$00` without it

---

## Phase 3 — Debug Core & Protocol

A straight lift. This is where full parity is bought cheaply, because almost
none of it is machine-specific.

### Tasks

1. Copy `src/debug/` whole: `Session.ts`, `Scheduler.ts`, `Breakpoints.ts`,
   `Disassembler.ts`, `OpcodeTable.ts`, `Expression.ts`, `Snapshot.ts`,
   `Checksums.ts`, `symbols/`, `server/`.
2. Drop `PNG.ts` and `KeyCodes.ts` — screenshot capture needs a framebuffer, and
   the key codes belong to the matrix keyboard. Replace the latter's role with
   `KeypadMap`.
3. Retarget `Snapshot.ts` at the KIM's device set: `pia`, `keypad`, `lcd`, the
   accessory's kind, and the Keypad Card ROM. The slot-layout check that refuses a
   snapshot from a differently configured machine stays exactly as it is.
4. Add a debug method to press a keypad key (`keypad.press`), so a scripted run
   can drive the monitor. Extend `Methods.ts` and the protocol doc.
5. Extend `symbols/parse.ts` acceptance to `KC Monitor.lst` alongside
   `BIOS.dbg` — the Keypad Card's labels are what a KIM session wants to see.
6. Copy the whole `src/tests/debug/` tree and re-point it.
7. Port `docs/DEBUG-PROTOCOL.md`, amended for the new and removed methods.

### Exit criteria

- Debug server tests, protocol tests and snapshot round-trips green
- A snapshot taken with the Serial Card fitted is refused by a machine without it
- `keypad.press` moves the monitor over the protocol

---

## Phase 4 — Electron Shell

### Tasks

1. Copy `src/main/` — `index.ts`, `boot.ts`, `serial.ts`, `settings.ts`,
   `debugBridge.ts`, `cliShim.ts`. Delete `storage.ts`.
2. Copy `src/preload/` and `src/shared/`. Strip `AppSettings` down to
   `serialConfig`, `frequency`, `serialCardFitted`, `accessory`; strip the IPC
   channel list of everything under `STORAGE_*` except `LOAD_DEFAULT_ROM`
   (which now loads two images).
3. Rename the CLI shim to `6502-kim` throughout, including the installer paths
   and the uninstall check.
4. `src/renderer/src/stores/emulator.ts` — port, minus video/sound/storage/RTC
   accessors and the BASIC pointer-fixup poll; plus `getLCD()`, `getPIA()`,
   `getAccessory()`, `pressKey(code)`.
5. `composables/`: keep `useSerial`, `useWebSerial`, `useBoot`, `useDebugBridge`,
   `useDefaultBIOS` (loading both ROMs), `usePaste`. Drop `useAudio`,
   `useJoystick`, `usePersistence`, `useKeyboard` (replaced in Phase 5 by the
   focus-aware router).
6. `App.vue` boot sequence: settings → machine → BIOS → Keypad Card ROM →
   reset → optional serial connect → run. No audio arming, no persistence load.

### Exit criteria

- `npm run dev` opens a window; the machine runs the monitor headlessly behind a
  placeholder UI
- A real serial port connects and the KC Monitor's `>` prompt answers it
- `6502-kim` shim installs and uninstalls from Settings

---

## Phase 5 — The Interface

### Tasks

1. **`App.vue` layout** — CSS grid: terminal (top-left), LCD (top-right), keys
   (bottom-right), accessory (bottom-left), control bar beneath. Panels keep
   their aspect ratios as the window resizes; the LCD and the pad never
   distort.
2. **`Terminal.vue`** — 40×24 canvas, white on black, monospace bitmap
   rendering. Fed by the store's transmit tap; emits typed bytes back.
   `CR`/`LF`/`BS`/printable only. Scrollback of a few hundred lines, with a
   copy-to-clipboard action. Block cursor while focused.
3. **`LCDPanel.vue`** — draws `LCDAttachment`'s pixel buffer to a canvas, to the
   specification in [The LCD panel](#the-lcd-panel). Every dot position drawn,
   lit and unlit; `-1` left as backlight; dot pitch snapped to whole device
   pixels; generous bezel; straight on. Double-click expands it to fill the
   window. Colours start at the values tabled there and are tuned side by side
   against `docs/reference/lcd-reference.png` until the two agree — that
   comparison *is* the acceptance test, so do it before moving on.
4. **`Keypad.vue`** — 4×6 grid from `KeypadMap`. Bebas Neue; hex keys black on
   white, function keys white on black; Heroicons for the arrows, text for
   `ESC` / `INS` / `DEL` / `PGUP` / `PGDN`. Press state on mouse-down and on
   host key-down. Every route calls `store.pressKey(code)`.
5. **`useFocusRouter.ts`** — one `keydown` listener at the window. Routes to the
   terminal or the keypad by which region holds focus; `Tab` cycles; `F11` /
   `Cmd+Enter` stay global for fullscreen. Prevents default only for keys the
   focused panel actually consumes, so browser shortcuts survive.
6. **`ControlBar.vue`** — port, with the button set decided above. Load Binary
   opens a small address prompt.
7. **`SettingsPanel.vue`** — port, with the sections decided above.
8. **`PasteModal.vue`** — port. Accepts bin2woz output as well as plain text;
   paces bytes into the ACIA.
9. Component tests for `KeypadMap` → UI wiring and the terminal's control-code
   handling.

### Exit criteria

- The LCD panel, expanded to fill the window, is indistinguishable from
  `docs/reference/lcd-reference.png` viewed straight on
- Both DOCS type-in procedures can be followed end-to-end **on the pad alone**:
  key an address, `INS`, key bytes, `►`, `▲` to run, `ESC` to stop
- The same session can be driven from the terminal with Wozmon syntax, and the
  LCD reflects a serial deposit at the next refresh
- Clicking between panels moves the keyboard, visibly
- Window resizes cleanly from small to fullscreen

---

## Phase 6 — Accessories

A plug-in bay on the bus, and the first thing to plug into it.

### Tasks

1. **`src/core/accessories/Accessory.ts`** — an `IO` implementation plus
   metadata: stable `id`, display name, the window it occupies, a one-line
   description, and the name of the Vue component that draws it.
2. **`src/core/accessories/registry.ts`** — the list. Built in, not user
   supplied; the interface is deliberately small enough that opening it up later
   is a decision, not a rewrite.
3. **`src/core/accessories/LEDLatch.ts`** — the KIM Demo. Write to any address
   in `$9400–$97FF` latches the byte and updates eight LEDs; **reads return 0**
   (open bus). `serialize`/`deserialize` carries the latched byte.
4. **`AccessoryPanel.vue`** — a dropdown of registered accessories plus the
   selected accessory's own component. Follows the app's conventions; makes no
   attempt to look like a breadboard.
5. **`LEDLatchView.vue`** — eight LEDs, bit 7 leftmost, matching how the DOCS
   card describes reading them. Lit LEDs glow; the byte is shown in hex beneath.
6. Changing the accessory rebuilds `io6` and warm-resets — swapping a circuit
   on a running machine is not a thing you do with the power on.
7. Tests: `LEDLatch.test.ts` (latching, open-bus reads, snapshot), and an
   integration test that runs the binary-counter program from the DOCS card and
   asserts the latch counts.

### Exit criteria

- The 18-byte binary counter and the 38-byte KITT scanner both run from `$0800`
  and drive the LEDs as the cards describe
- With the LED latch fitted, `HW_PRESENT` still reads `HW_SC` alone — the latch
  does not pass `ProbeGPIO`
- The accessory survives a snapshot round-trip

---

## Phase 7 — Command Line

### Tasks

1. Copy `src/cli/` and `src/host/headless/`; rename the binary and every usage
   string to `6502-kim`.
2. `bin/6502-kim` dev entry point.
3. Commands and flags, adapted:
   - `6502-kim run [--rom] [--card-rom] [--bin addr=file] [--serial port]
     [--freq] [--pause] [--debug] [--accessory <id>]`
   - `6502-kim dbg` — attach, break, step, memory, disassemble, plus
     `key <name>` to press a pad key
   - Dropped: `--cart`, `--cf`, `--nvram`, `--rtc`, `--prg`
4. `SerialConsole.ts` becomes the headless terminal — stdin to the ACIA, ACIA to
   stdout — which is exactly the KC Monitor's serial monitor on a TTY.
5. A headless LCD renderer: the 16×2 text content as two lines, for scripted
   assertions and for `--lcd` on the console.
6. Port `src/tests/cli/` and `src/tests/host/`.

### Exit criteria

- `6502-kim run --serial /dev/tty.…` bridges a real port
- `6502-kim run` with no display gives a working Wozmon session on the terminal
- `6502-kim dbg` sets a breakpoint in Keypad Card ROM by symbol name

---

## Phase 8 — Web Build & Embed

### Tasks

1. `vite.web.config.ts` port; Web Serial through `useWebSerial`; both ROMs
   fetched from `public/roms/`.
2. `embed.html` / `EmbedApp.vue` / `EmbedControlBar.vue` port. Embed parameters
   trimmed to what a KIM has: `rom`, `bin`, `accessory`, `freq`,
   `autostart`, `panels` (which of terminal/lcd/keys/accessory are shown).
3. `embed/messaging.ts` — keep the postMessage API; add a message to press a
   keypad key, so a docs page can demonstrate a keying sequence.
4. Port `docs/EMBEDDING.md`, rewritten for the KIM's parameters.
5. Pages deploy workflow verified end to end.

### Exit criteria

- The browser build boots to the KC Monitor and takes keyboard input
- An `<iframe>` embed with `panels=lcd,keys` shows only those two
- `EmbedParams.test.ts` covers every parameter

---

## Phase 9 — README, LICENSE & Examples

### Tasks

1. **`LICENSE`** — MIT, copyright A.C. Wright, matching the family.
2. **`README.md`**, in the house style of the 6502-EMULATOR and 6502-KIM
   READMEs: what it is, try-it link, the overlay memory map, hardware
   emulated, the pad and its keycodes, the controls, the accessory bay,
   settings, the CLI, embedding, building from source, the family table, and a
   licence section. Cross-link the DOCS KIM chapter and keypad map, the
   hardware repo, and bin2woz.
3. **`examples/`** — port the harness (`lib.sh`, `run-all.sh`) and write KIM
   examples:
   - `01-monitor-over-serial.sh` — deposit and run over Wozmon syntax
   - `02-key-in-a-program.sh` — drive the pad through the debug protocol
   - `03-led-counter.sh` — run the DOCS binary counter and assert the latch
   - `04-deterministic-run.sh` — fixed cycle budget, checksummed result
   - `05-raw-protocol.sh` — the protocol without the CLI
4. `examples/embed.html` for the embed parameters.
5. Wire `examples/run-all.sh` into CI.

### Exit criteria

- `bash examples/run-all.sh` passes locally and in CI
- Every command in the README is one an example actually runs

---

## Phase 10 — Release v1.0.0

### Tasks

1. Version to `1.0.0`; final `npm run typecheck && npm test && bash
   examples/run-all.sh`.
2. Confirm the bundled ROMs match their upstream sources, and that
   `roms/README.md` names the commits.
3. Commit the release; **tag `v1.0.0`** (annotated, with the summary as the tag
   message).
4. Build: `npm run dist:mac` (arm64 dmg, signed and notarised),
   `npm run dist:win` (x64 nsis), `npm run dist:linux` (AppImage + deb).
5. Push `main` and the tag; confirm CI green and the Pages deploy live.
6. **GitHub release** on `v1.0.0` with the three platform artifacts attached and
   a summary covering: what the KIMulator is, the KC Monitor boot, the four
   panels, the accessory bay and the LED demo, the `6502-kim` CLI, the browser
   build and embed, and what is deliberately absent (video, sound, storage,
   BASIC). Link the DOCS KIM chapter, the hardware repo and 6502-EMULATOR.
7. Smoke-test each downloaded artifact on its platform before announcing.

### Exit criteria

- `v1.0.0` tagged and pushed
- Three platform artifacts attached to the release and each one launches
- The browser build is live on GitHub Pages
- The release summary reads as a description of the machine, not a changelog

---

## Deferred

Not in v1.0.0, and deliberately so:

- **DOCS integration.** `6502-DOCS` says the KIM is the one machine the emulator
  cannot pretend to be, and `docs/using/emulator.md` and `docs/addons/kim.md`
  will both want revising once this ships. That is a change to a repository this
  plan does not touch.
- **More accessories.** The registry is built for it: a second latch, a relay
  board, a seven-segment display. The interface stays closed to user-supplied
  plug-ins until there is a reason to open it.
- **A shared core library.** Two duplicated cores is the accepted cost today.
  Revisit only if the drift between them starts producing bugs.
- **Cassette / paper tape.** The original KIM-1 had them; this one does not, and
  the Wozmon upload path covers the same ground.
