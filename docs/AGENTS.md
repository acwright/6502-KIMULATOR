# Working notes for 6502-KIMULATOR

Read this before changing anything here. It is what the machine is, where the
code comes from, the conventions the repository is held to, and what building it
taught. The original build plan it condenses is no longer in the tree; it is in
history, as `git show a21748b:PLAN.md`.

> [DRIVING.md](DRIVING.md) is the user-facing guide — *driving the emulator from
> an agent*, the direct descendant of `6502-EMULATOR/docs/AGENTS.md`, written to
> be copied into someone else's project. It documents commands, so it landed
> with the CLI in phase 7. **This** file is the working notes for building the
> emulator; that one is for using it.
>
> [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md) is the reference for the JSON-RPC
> service, method by method. `6502-kim dbg` and `6502-kim attach` are clients of
> it, and so is anything that can post JSON.

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
src/core/accessories/       the bay at $9400 and what plugs into it
src/debug/         session, scheduler, disassembler, snapshots, the debug server
src/main/          Electron main process
src/preload/       the contextBridge
src/renderer/src/  the Vue app — panels, stores, composables
src/renderer/src/embed/     the embed page's URL API, postMessage layer and pad
src/shared/        types crossing the main/renderer boundary
src/cli/           the 6502-kim command line
src/host/headless/ the windowless host the CLI drives
src/tests/         everything, mirroring the tree above
assets/roms/       ROMs for Electron and the CLI (extraResources)
src/renderer/public/roms/   the same ROMs for the web build
docs/reference/    source material — see lcd-reference.png
docs/DEBUG-PROTOCOL.md      the JSON-RPC service, method by method
docs/DRIVING.md             how to drive the machine from a shell or an agent
docs/EMBEDDING.md           the embed page's parameters, sizing and postMessage API
```

Path aliases, in every config: `@core`, `@debug`, `@shared`, `@renderer`, and
`@` for `src/renderer/src`.

## Running it

```sh
npm ci
npm run typecheck        # vue-tsc over the renderer + tsc over main
npm test                 # jest, with coverage, over core/debug/host
npm run dev              # electron-vite — the desktop app
npm run build:web        # static site into dist/web — index.html + embed.html
npm run preview:web      # serve it at localhost:4173/6502-KIMULATOR/
npm run icons            # regenerate every icon format from build/6502.png
npm run build:cli        # tsc -p tsconfig.cli.json — then bin/6502-kim runs it
```

`npm run typecheck` covers three projects, not two: the renderer, main, and
`tsconfig.cli.json`. Without that third one nothing in `src/cli` or `src/host`
is typechecked until somebody builds the CLI, and CI never does.

`npm run icons` needs ImageMagick 7 (`magick`) and macOS `iconutil`/`sips`. The
generated `icon.icns`, `icon.ico`, `icon.png` and `icon.iconset/` are tracked, so
CI never has to run it.

## Project status

The build is finished. The emulator shipped as v1.0.0 and is maintained as
v1.0.x releases — `package.json` carries the current version. It was built in
eleven phases, and the notes below still name them where a phase is the reason
something is the way it is:

- **0** — repository, toolchain, icon, CI
- **1** — core port
- **2** — the Keypad Card
- **3** — debug core & protocol
- **4** — Electron shell
- **5** — the interface
- **6** — accessories
- **7** — command line
- **8** — web build & embed
- **9** — README, LICENSE & examples
- **10** — release v1.0.0

`npm run dev` opens a window onto a KIM you can use: it boots both ROMs, prints
the KC Monitor's banner to the terminal, shows `KIM MONITOR v1.0` on the glass,
answers the pad, and — with the KIM Demo wired to the bay — runs both of the
DOCS type-in cards and lights the LEDs. `6502-kim run --headless` is the same
machine with no window: `printf '\x1b0800: A9 41\r'` into it deposits a byte
through the monitor's serial prompt, and `6502-kim dbg key`/`lcd` drive the pad
and read the glass. `npm run build:web` is that window as two static pages, and
an `<iframe>` on someone else's article is a machine they can key a program
into. [../examples/](../examples/) drives all of that from a shell and CI runs
it, so a documented command that stops working stops the build.

**Everything above ships, and everything a KIM does not have is absent** —
video, sound, storage, RTC, RAM banks, joysticks, the matrix keyboard, BASIC, and
a cartridge slot (see [What this is not](#what-this-is-not)). The repository is
on ordinary footing: changes are changes, and the next version number is earned
by one.

The Electron shell is a lift, minus everything a KIM has no hardware for.
`storage.ts` is gone entirely and `roms.ts` stands in its place: a KIM has no CF
card and no NVRAM, and loses its RAM when you switch it off, so the only file
the renderer still needs main to read is a ROM image — **two** of them, since
the Keypad Card carries its own. `IPC.ROMS_LOAD_DEFAULT` returns both together.

**There is no save-before-quit.** The ACE intercepted the window close to give
the renderer time to write its card out; with nothing to persist, the intercept
and its `APP_BEFORE_QUIT` / `APP_SAVE_COMPLETE` channels are gone, and `close`
does one thing — stops the debug bridge, so a client mid-call gets an answer
instead of a timeout.

`AppSettings` is down to three fields: `serialConfig`, `serialCardFitted` and
`accessory`. There is no `frequency` — PHI2 on this board is 1 MHz and the ACE
is the machine with the 2 MHz jumper. The last two are the machine's *shape*, and
a card cannot be fitted or pulled with the power on — so `store.init()` builds a
new Machine and a new Session rather than mutating one. That is why
`useDebugBridge` keeps its watch armed instead of firing once: a bridge still
holding the old Session would be answering a debug client about a machine that
is no longer on the bench.

`usePaste` no longer synthesises key presses the way the ACE's did — there is no
matrix keyboard to synthesise them on. It feeds bytes to the ACIA paced at the
line rate, which is why it takes `bin2woz` output for free: those are Wozmon
deposit lines, and the machine cannot tell them from someone typing quickly.

**Serial flow control is a setting, on by default** (`AppSettings.flowControl`,
`--no-flow-control`, `session.info.flowControl`): whether the far end of the cable
honours RTS. `Machine.flowControl` sets it on the ACIA; `ACIA.readyToReceive` and
`Machine.serialReady` say whether input would be held, and `SerialConsole.pump`
sends nothing while it would. `ACIA.ts` and its test are byte-identical with
6502-EMULATOR's: an R6551 whose receiver, transmitter and interrupts are off until
command register bit 0 is set, so a byte sent to it before then is lost, and whose
transmitter is off again whenever bits 3-2 are `00` — raising RTS stops it sending
as well, and TDRE never sets, so firmware that echoes while RTS is high spins for
good. RTS is high from reset until `KernalInit` writes `$09`, and the KC Monitor
never raises it after that, so the monitor is clear of it; BIOS 1.6's and 2.0's
BASIC are not. `AppSettings.settingsVersion` 2 marks a file migrated to the new
default.

**There is one console buffer and everything reads it.** `useConsole` owns a
`TerminalBuffer`; the Terminal panel draws it, the Paste box feeds it, and
`RendererTarget`'s `serial.read` / `serial.write` / `onSerial` are that same
buffer. A second, invisible one would mean a debug client and the window
disagreeing about what the machine has said — which is why phase 4 left those
methods unimplemented rather than wiring them to a private buffer.

**The transmit tap is a fan-out, not a callback.** `store.onTransmit(cb)`
returns an unsubscribe and the store keeps a set. The terminal holds one for the
app's lifetime and `useSerial` / `useWebSerial` hold one each while a port is
open; with the old single slot the two would evict each other and plugging in a
laptop would blank the window. The panel is a *tap* on the ACIA's transmit line,
not a second device, which is what makes both views show the same traffic.

**Building the machine lives in `useMachine`, not in App.vue.** Fitting or
pulling the Serial Card constructs a new Machine, so the firmware has to go back
in — and the images live with whoever fetched them. Auto-boot and the Settings
toggle are the same sequence with different arguments, and having one of them
rather than two spelled out separately is what keeps a rebuilt machine identical
to a freshly launched one.

**The panels' logic is outside their `.vue` files, on purpose.** The terminal's
control-code handling is `terminal/TerminalBuffer.ts`, its key mapping
`terminal/keys.ts`, its character generator and picture `terminal/font.ts` and
`terminal/render.ts`, the pad's map-to-panel wiring `keypad/layout.ts`, and the
LCD's drawing `lcd/render.ts`. All of them are covered by `src/tests/renderer/`
and named in `jest.config.cjs`'s `collectCoverageFrom`; the components are markup
over them. Extracting the LCD's drawing is what made it possible to point the
real renderer at a real pixel buffer and hold the result next to the photograph.

**The terminal is a screen, not a text box.** `terminal/render.ts` draws a fixed
320 × 240 raster — 40 × 24 characters of 6 × 8 in the middle, overscan around
them — and the panel scales that whole picture to fit, the way 6502-EMULATOR
scales its video buffer. The glyphs in `terminal/font.ts` are the ACE's, base64
of the 256 CP437 patterns the BIOS seeds its video card with, re-extracted from
`6502-DOCS/data/charset.json` rather than edited. They are drawn five wide and
left-aligned in the byte; bits 1-0 are clear in all 2,048 rows and bit 2 is set
only in the box-drawing glyphs, which is how you know the cell is six wide and
carries its own gap. Sizing the tube has the same trap the keypad had — see
below — and the same fix: `width: min(100%, 100cqh * 4 / 3)`, because a box with
a definite height and `max-width` on it does not re-derive its ratio, it just
squashes.

**Two numbers in the LCD spec were wrong, and the reference says so.** The build
plan's table was read off the image by eye; measuring it gives:

- **Bezel is 3 dot pitches, not 5.** About three pitches of backlight above and
  below the character area in the reference. Its side margins are narrower, but
  that panel was stretched to fill its window instead of keeping the character
  area's aspect ratio, so the horizontal figure describes the window and not the
  design.
- **The dot gutter is ~30%, not 20%.** Scanning a character row, the dark runs
  take about two thirds to three quarters of each pitch. At 20% the unlit dots
  very nearly touch and blank cells read as solid blocks; at 30% each dot is
  distinct with backlight all round it, which is the texture the photograph has.

Both are written into `lcd/render.ts` as round numbers — 3 pitches, 30% — and
should stay round. The reference is a blurred photograph of a screen; it can say
"about a third", and a constant with more digits in it than that is reading its
own noise rather than the hardware.

The colours were already right: the reference's unlit dots sample at #8DA93D
against the spec's #8AA33B, and the ratio to the backlight comes out at 80%,
matching the 0.80 the build plan recorded. Its *lit* pixels sample far brighter
than #101B04, which is the blur — a photograph can only pull the two together, so
the real contrast was at least this high.

**The keypad is letterboxed by arithmetic, not by `aspect-ratio`.** A grid whose
only sizing is a ratio plus max-width/max-height has nothing to compute a size
*from* inside a centring flex box — the buttons have no intrinsic size either —
so it collapses to nothing, which is exactly what it did the first time the app
was run. `GRID_STYLE` sizes it with `min(100cqw, 100cqh * 4 / 6)`: container
units are absolute lengths, so unlike percentages they can be compared across the
two axes.

**Nothing routes a key except `useFocusRouter`.** One `keydown` listener at the
window, and it calls `preventDefault` only for keys the focused panel said it
consumed — that is what keeps Cmd+C, Cmd+R and the rest working while the
terminal has the keyboard. Fullscreen is answered before anything is routed,
because it belongs to the window rather than to whatever holds the keyboard, and
typing into any `input`/`textarea`/`select` is not input to the machine at all
(without that, keying an address into Load Binary would also key it into the
monitor).

**The accessory bay is one identifier all the way down.** A circuit's registry
`id` *is* its `IO.kind` (`led-latch`) — the string settings persist, the one
`--accessory` will take, and the one `Snapshot.ts`'s slot-layout check compares.
So a snapshot taken with the LEDs fitted already refuses to restore into an empty
bay, with no accessory-specific code in the snapshot at all. `registry.ts` is the
only list; adding a circuit is an entry there plus one line in
`AccessoryPanel.vue`'s `VIEWS` map, which is the single place a component *name*
becomes a component — core knows nothing about Vue. An id this build has never
heard of leaves the bay empty rather than failing the boot, because a settings
file written by a later version should still give you a machine you can use.

**`LEDLatch` reads back open bus, and that is load-bearing.** `ProbeGPIO` writes
$AA to `GPIO_DDRB` — $9402, inside io6 — and reads it back; a card that echoed
the write would set `HW_GPIO` on a machine with no VIA in it, and `SysDelay`
would then wait on a hardware timer that is not there. That routine is the delay
loop *both* DOCS programs are built on, so the convenient version of this card
breaks the two things it exists to run. `LEDDemo.test.ts` checks the firmware
agrees: `HW_PRESENT` still reads `HW_SC` alone with the latch fitted. The probe's
own $AA does flicker the lamps on every boot, exactly as on the bench.

**And a reset does not clear it.** A 74HC373 has no clear pin, so
`reset(coldStart)` empties the latch on a cold start only. Pressing `ESC` to stop
a program leaves the lamps holding whatever it last wrote; that is the hardware,
not an oversight.

**Fitting a circuit rebuilds the machine, and `useAccessory` is shared.** The bay
in the window and the ACCESSORY section in Settings are two views of one choice —
two dropdowns that could disagree about what is on the bus would be worse than
either alone. What is *fitted* is read back off `machine.io6` rather than from the
remembered selection, because after a rebuild the machine is the only thing that
knows what actually went in.

**`LEDDemo.test.ts` is the first test to take `Snapshot.ts` up on what it was
written for**: boot the monitor once, save there, restore per case. Ten cases run
in under two seconds, where paying the LCD's power-on ritual each time would have
cost about 1.8 M cycles apiece.

**`npm run typecheck` used to check nothing in the renderer.** The root
`tsconfig.json` is references-only (`files: []`), and `vue-tsc --noEmit` does not
build referenced projects — so it silently passed on code it had never read. It
now names `tsconfig.web.json` explicitly, which needed the same
`noUnusedLocals` / `noUnusedParameters` relaxation `tsconfig.node.json` already
carries and for the same reason: both reach into `src/core`, where an IO card's
`tick(frequency)` matches the interface rather than using the argument. If you
change the typecheck script, check it still fails on a deliberate type error.

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

`src/cli/` and `src/host/headless/` are a lift too, and the same rule decided
what came across: the flag survives if the hardware behind it does.

**`--freq` and `--rtc` are gone, and they are gone for opposite reasons.** PHI2
on this board is 1 MHz, so there is nothing to select — `session.config` refuses
a different one rather than ignoring it, and `dbg config --frequency` is kept
precisely so a script ported from the ACE is *told*. `--rtc` existed to pin the
one input the engine read from the host clock; a KIM has no clock card, so there
is nothing to pin and **every headless run is already reproducible**. That is
worth stating in the guide rather than leaving someone to discover it.

**`--no-serial-card` replaces `--empty <cards>`.** Only two of the eight slots
are ever filled here and each has its own flag, so a comma-separated list of
slot aliases would be a general mechanism with two members. Pulling io5 is the
one that changes behaviour: `HW_PRESENT` comes back without `HW_SC` and the KC
Monitor takes its keypad-only path.

**A keypad-only machine has no console, and `HeadlessTarget` says so.** Its
`serial.*` methods are assigned in the constructor only when the card is fitted,
so the method table answers NOT_SUPPORTED instead of accepting bytes and dropping
them — and `attachStdin` does not even attach, which also stops a resumed stdin
holding the process open after the run ends. `RendererTarget` differs here on
purpose: the Terminal panel's buffer exists either way, so the window always has
somewhere to put them.

**The headless display is text, and `--lcd` writes it to stderr.** Sixteen by two
is small enough to read as characters, so there is no PNG encoder and no
framebuffer; `formatLCD` boxes the two lines because trailing blanks are a state
of the panel rather than padding. stderr, because stdout is the machine's serial
stream and belongs to it. `RunResult.lcd` is always populated for the same
reason it exists at all: on a machine with no Serial Card it is the whole of what
the run produced.

**`dbg key` takes a bare number as a name, not a code.** `key 0` presses the zero
key, which reports `$0A`; `key '$0A'` says the same thing the other way. Reading
a bare `0` as an encoder code would press `◄`, and `KeypadMap` exists precisely
so that nothing derives one from the other. A whole sequence goes to one call,
because the pacing that keeps the 74C922's latch from losing a keystroke is
measured in emulated cycles and separate processes cannot pace anything.

**Two small divergences in the client, both earning themselves.** `unescape`
learned `\xNN`, because the splash waits for ESC and a shell argument cannot hold
one — the alternative was `--encoding base64 Gw==`. And `mem` converts a hex
address to a number for every space but `cpu`, which takes an offset into an
image over the wire: without it `mem 0x1FFC --space card`, the card's reset
vector and the most obvious thing to look at, comes back "expected a number".

**Both bundled images are found by the same walk, and both are checked.**
`readROM` wants 32 KB and `readCardROM` wants 8 KB, separately, because the
mix-up is otherwise silent in one direction: an 8 KB image loaded as the BIOS
gives a machine that boots and falls over the first time it calls the Kernal.

**Deposits go at `$0800`, and a test that types one must check the machine
survived it.** `PROGRAM_START` is `$0800`; below it is the firmware's own
workspace — `$0200-$027F` is the KC Monitor's Wozmon line buffer, `$0400-$04FF`
its serial RX ring, and `$0300-$03FF` is `KERNAL_VARS`, whose first two bytes
are **`IRQ_PTR`**. (The family-wide `6502.inc` calls `$0200-$02FF` the Kernal's
`INPUT_BUFFER`; on a KIM that ring is never fed, because the cartridge owns
`IRQ_PTR`. The KIM's own `kim.inc` is the file that says so.) Depositing at
`$0300` therefore
rewrites the IRQ vector, and the next character to arrive vectors the CPU into
empty RAM. The symptom is a machine that stops answering with bytes piling up
unread in the ACIA's receive queue, which reads exactly like a broken serial
path and is nothing of the kind — it was diagnosed once by finding the PC stuck
at `$41A9`, which is `A9 41` byte-swapped, the very bytes the deposit wrote.
`HeadlessHost.test.ts` asserts `cpu.pc >= $8000` after typing at the prompt for
this reason: the read-back alone passes either way.

**The `--serial` bridge is verified against real hardware**, not just reasoned
about: two USB-serial adapters wired together, the emulator holding one and a
script the other. Banner, prompt, ESC, deposit and read-back all crossed the
wire in both directions. Worth knowing if you repeat it: that rig delivers each
write about half a second late, so a test that samples sooner than that sees
nothing and looks like a failure. Nothing needs DTR/RTS asserted, which is why
`serial.ts` does not.

`vite.web.config.ts` builds two pages out of one tree: `index.html` is the app,
`embed.html` is the same machine as a guest on someone else's page. They share
everything below the component layer, so Rollup splits the emulator into a chunk
they both load rather than shipping it twice — which is the reason the embed is
a second *entry point* rather than a flag on `App.vue`, since above the panels
the two have almost nothing in common. `docs/EMBEDDING.md` is the user-facing
half of all of this.

**The embed was verified in a browser, not reasoned about.** Headless Chrome
over CDP against `vite preview`: the app boots to `KIM MONITOR v1.0` with the
splash on the glass, ESC typed into the terminal starts the monitor,
`panels=lcd,keys` shows exactly those two, `bin64=$0800=…&accessory=led-latch&
keys=ESC,UP` runs the DOCS binary counter with the lamps counting, and a host
page framing `embed.html` drove it to `$1234` entirely over `postMessage`. Do
that again rather than trusting a build that merely compiles — three of the
things fixed below looked fine until a real browser ran them.

**`6502-kim:ready` fires about three seconds before the machine can hear
anything**, and that is not a bug to fix by moving the event. The splash costs
~1.8 M cycles to reach; `ready` means the firmware is in and the power is on,
which is what a host page needs in order to send `run`. So `key` and `type` wait
behind a gate (`whenReady` in `EmbedApp.vue`) and the four that *operate* the
machine — run, pause, reset, powerCycle — do not. Without that gate a host page
keying on `ready` presses ESC into `LcdInit` and the keystroke is simply gone,
which is what the first browser run showed.

**The prefixes are the KIM's own**: `6502-kim:` for messages and `data-kim-` for
the loader's attributes, where 6502-EMULATOR uses `6502:` and `data-6502-`. The
DOCS site will document both machines on one page, and identical prefixes would
mean each loader claiming the other's containers and a mistargeted `postMessage`
resetting the wrong emulator. Same reasoning as `~/.6502-kim` and
`6502-kim-snapshot`.

**The embed does not take the keyboard until it is clicked**, where `App.vue`
gives the pad the keyboard as it mounts. The window *is* the machine; a frame
halfway down an article is a guest, and one that swallowed the reader's
page-down key on load would be a bad one. The same click-to-focus router runs in
both, and `focus()` is simply never called before the first pointer event.

**`params.ts` reaches into `@core` for two lookup tables** — `KeypadMap` through
`embed/keys.ts`, and the accessory registry — which is a deliberate exception to
its otherwise import-free rule. Both are pure data, they cost the node-only test
suite nothing, and they are what let a mistyped key name or an unknown accessory
be reported at parse time next to every other malformed parameter, rather than
discovered silently three steps later. `keys=` and `6502-kim:key` read a bare
token as a **name** (`0` is the zero key, reporting `$0A`) exactly as
`6502-kim dbg key` does, and `autotype`'s escapes are character for character
the CLI's `unescape`, `\xNN` included — the splash wants an ESC and an
`<iframe>` tag is as awkward a place to put one as a shell argument.

**Two things the web build was quietly missing**, both found by running it.
`useFocusRouter` swallowed F11 unconditionally to call `window.api` — which in a
browser took the fullscreen key away and gave nothing back, so it now returns
early when there is no Electron window to answer for. And every page load 404'd
on `/favicon.ico`; `src/renderer/public/favicon.png` is the app icon at 64 px,
linked relatively so one line serves both pages, the Pages base path and the
Electron renderer.

**`useWebSerial.ts` is gone, and Web Serial still works.** It was an unused
duplicate of `WebSerialService` in `services/serial.ts`, which is the live path —
`useSerial` picks between that and Electron's IPC at construction, and the
Settings panel's Connect button reaches `requestPort()` in a browser through it.
Two implementations of one port would have been the transmit-tap problem again:
whichever a future caller wired up second would have delivered every received
byte twice. What did have to move is the Web Serial *ambient types*, which lived
in that file and are now in `env.d.ts` where the rest of the globals are.
