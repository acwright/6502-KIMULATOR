# 6502 KIMulator

Desktop and web emulator for the [A.C. Wright 6502-KIM](https://github.com/acwright/6502-KIM) — the **Keypad Input Monitor**, the member of the [AC6502](https://github.com/acwright/6502-ACE) family with a 24-key pad, a 16×2 LCD, and a Keypad Card that takes over the top of the memory map.

Runs on **macOS, Windows, and Linux** as a native Electron application, and in any modern browser via **[GitHub Pages](https://acwright.github.io/6502-KIMULATOR/)**.

## Try It in the Browser

[https://acwright.github.io/6502-KIMULATOR/](https://acwright.github.io/6502-KIMULATOR/)

It boots to the KC Monitor's splash and waits, exactly as the real one does.
Press **ESC** — on the pad or in the terminal — and you are in the monitor.

The same build also ships an `embed.html` page for putting a machine in an
`<iframe>` on your own site — see [Embedding](#embedding).

> 📖 **Guide:** [AC6502 Documentation](https://acwright.github.io/6502-DOCS/) — the user's and programmer's guide for the whole family.
> [The KIM keypad chapter](https://acwright.github.io/6502-DOCS/addons/kim) is the tutorial half of this README, and
> [the keypad map](https://acwright.github.io/6502-DOCS/reference/keypad-map) is the printable version of the table below.

---

## What This Is

A faithful emulation of a KIM **as it is actually built**: a 65C02, 32 KB of RAM,
32 KB of BIOS ROM, a Serial Card, and — the thing that makes it a KIM — a
**Keypad Card** carrying its own PIA, its own 8 KB ROM and its own vectors. It
boots into the **KC Monitor**, not into BASIC.

Four things on screen, and one of them is a slot you can wire a circuit into:

| Panel | What it is |
|---|---|
| **Terminal** | 40×24, white on black. Exactly what the serial port sees, in both directions |
| **LCD** | The 16×2 HD44780 on the Keypad LCD Helper, drawn as a real dot-matrix panel — the unlit dots included |
| **Keys** | The 24-key pad on the Keypad Helper, laid out and coloured like the real one |
| **Accessory** | A slot on the bus at `$9400` where a breadboard circuit is wired. First one: eight LEDs behind a 74HC373 latch |

**There is no cartridge slot.** The Keypad Card *is* this machine's cartridge and
it is soldered in, so "Load Cart" does not exist here in any form — not on the
toolbar, not as a CLI flag, not as an embed parameter. What you can load is a
BIOS, a binary at an address, and the Keypad Card's own firmware.

Deliberately absent, because a KIM has none of it: video, sound, storage, a
real-time clock, RAM banks, joysticks, the matrix keyboard, and BASIC. That is
[6502-EMULATOR](https://github.com/acwright/6502-EMULATOR)'s job — same family,
different machine.

---

## Memory Map

The Keypad Card overlays the top of the address space, so it is decoded
**before** ROM:

```
$0000–$7FFF   RAM                     32 KB SRAM
$8000–$9FFF   I/O slots               eight 1 KB windows
$A000–$B7FF   BIOS Kernal             from BIOS.bin, still callable
$B800–$BFFF   CP437 character set     from BIOS.bin, still readable
$C000–$DFFF   PIA (65C21)             mirrored every 4 bytes — A0=RS0, A1=RS1
$E000–$FFF9   Keypad Card ROM         AT28C64, 8 KB — KC Monitor
$FFFA–$FFFF   CPU vectors             the Keypad Card's own
```

Of the eight I/O slots only two are ever filled:

| Slot | Window | Fitted |
|---|---|---|
| `io5` | `$9000–$93FF` | **Serial Card** — 6551 ACIA. Toggleable; `KC Monitor.asm` guards every ACIA access on `HW_PRESENT & HW_SC`, so unfitting it is the only way to exercise the keypad-only path the firmware supports |
| `io6` | `$9400–$97FF` | **Accessory bus** — empty, or whatever you wire to it |

Program space is `$0800–$7FFF`. Below it is the machine's own workspace — zero
page, the stack, the 256-byte input buffer at `$0200`, and `KERNAL_VARS` at
`$0300` (whose first two bytes are `IRQ_PTR`). Nothing stops you writing there,
exactly as nothing stops you on the bench.

---

## Hardware Emulation

| Component | Details |
|---|---|
| **CPU** | W65C02S, cycle-accurate, IRQ / NMI, full opcode set including the `WAI` / `STP` halt states. PHI2 is 1 MHz — the 2 MHz jumper is the ACE's |
| **RAM** | 32 KB, flat. No banks, and no persistence: a real KIM loses its RAM when you switch it off |
| **ROM** | 32 KB BIOS (bundled, replaceable) + the Keypad Card's 8 KB AT28C64 (bundled, replaceable) |
| **PIA** | 65C21 — Port A carries the keypad code (`PA0–PA4`) and the LCD control lines (`PA5`=RS, `PA6`=R/W, `PA7`=E); Port B is the LCD data bus. CA1 is the keypad's data-available interrupt, CA2 the encoder's output enable |
| **Keypad** | MM74C922 extended to 24 keys with a 74HC00. Scanning, debounce and encoding are all in hardware — and **releases are ignored**, because the encoder reports the press and nothing else |
| **LCD** | 16×2 HD44780 with the A00 font — DDRAM, CGRAM, entry mode, display shift, cursor and blink |
| **Serial** | 6551 ACIA — configurable baud/parity/data/stop, 19200 8-N-1 by default |
| **Accessory** | Whatever is wired to `$9400`. Shipped: the KIM Demo's eight LEDs behind a 74HC373 latch |

---

## The Pad

Twenty-four Cherry MX switches in a 4×6 grid, with the encoder's code beside each
key:

| | | | |
|---|---|---|---|
| `ESC` $10 | `INS` $11 | `PGUP` $12 | `A` $13 |
| `▲` $14 | `DEL` $15 | `PGDN` $16 | `B` $17 |
| `7` $07 | `8` $08 | `9` $09 | `C` $0F |
| `4` $04 | `5` $05 | `6` $06 | `D` $0E |
| `1` $01 | `2` $02 | `3` $03 | `E` $0D |
| `◄` $00 | `0` $0A | `►` $0B | `F` $0C |

The display and the pad are one card, and the UI draws them as one: same width,
the same space between them as there is between two keycaps, no divider across
them, and centred together in their panel.

**The code is not the value.** `0` is `$0A`, `$00` is the left arrow, and `C`–`F`
run backwards — the encoder numbers the switches in the order they sit on the
board. One table (`src/core/KeypadMap.ts`) is shared by the UI, the CLI, the
embed and the tests, so there is exactly one place that can be wrong.

Keying a program in is the machine's own way in, and it works with no Serial Card
at all:

| Step | Keys |
|---|---|
| Go to an address | `0` `8` `0` `0` |
| Enter data-edit mode | `INS` |
| Key a byte, then step on | `A` `9` `►` |
| Leave data-edit mode | `INS` |
| Run from the current address | `▲` |
| Stop, back to the monitor | `ESC` |

`▲` runs the program **as a subroutine**, so an `RTS` comes back to the monitor.
(The serial monitor's `XXXX R` is Wozmon's, which is a `JMP` — see
[Command Line](#command-line).)

---

## Controls

Terminal and keypad are focusable regions: click one to give it the keyboard,
`Tab` cycles, and a small keyboard badge in the corner of each panel lights on
whichever is holding it. The pad has it at launch — it is the machine, and it is
what the splash is waiting for. Mouse clicks on the pad work whatever has focus.

When the pad is focused it takes `0`–`9`, `A`–`F`, the arrow keys, `Enter` (as
`▲`), `Esc`, `Insert`, `Delete`, `PageUp` and `PageDown`. Double-clicking the LCD
expands it to fill the window; **F11** (or **⌘ Return**) toggles fullscreen.

### Control Bar

| Button | Action |
|---|---|
| **CPU chip** | Load BIOS ROM (`.bin` / `.rom`) — 32 KB, replaces the bundled image |
| **Document$** | Load Binary — raw bytes at an explicit hex address, the type-in card without the typing |
| **▶ / ■** | Run / Stop emulation |
| **↺** | Reset — pulses the CPU RESET line only; RAM is preserved, mirroring the hardware reset button |
| **⏻** | Power Cycle — cold boot that zeroes RAM and clears the terminal |
| **⌨** | Show / hide the on-screen keyboard — see below |
| **Clipboard** | Paste — types text into the machine down the serial line, paced so the ACIA can absorb it. Accepts [bin2woz](https://github.com/acwright/bin2woz) output directly |
| **⚙** | Open / close the Settings panel |

No frequency toggle and no mute button: one clock, no sound card.

A **KIM / TERM / BAY** switch appears at the left of the bar when the window is
showing one panel at a time — see *Small windows* below.

### On-screen Keyboard

The **⌨** button raises a 6502 keyboard wired to the serial port: the same 67
keys in the same places as the ACE's, from
[the keyboard chapter](https://acwright.github.io/6502-DOCS/using/keyboard) and
[the keyboard matrix](https://acwright.github.io/6502-DOCS/reference/keyboard-matrix).

A KIM has no keyboard of its own, but this is the board you would wire to its
serial line, and what it puts on that line is what the AB Controller puts on it:
capitals, Shift for the symbols and the number row, `Ctrl`+`A`–`Z` for
`$01`–`$1A`, and nothing at all from `Caps Lock`, `Menu`, `Alt` or `Fn`. Shift
and Ctrl latch — tap to arm for one key, again to lock.

Keys from it go to the terminal, so pressing one moves the keyboard there. The
pad is the machine's own way in and is unaffected.

### Small Windows

Two columns need a window wider than it is tall and big enough in both
directions. Below that — a phone either way up, an iPad in portrait, a short
desktop window — the window shows one panel at a time and the control bar carries
the switch: **KIM** for the display and the pad, **TERM** for the terminal,
**BAY** for the accessory. The panel showing is the one the keyboard goes to.

In landscape the on-screen keyboard sits beside the panels rather than under
them, and the pad sits beside the display rather than under it: everything in a
window that shape is limited by height, so side by side lets both take that
height instead of splitting it.

The [embed](#embedding) does all of the same things, in its own frame rather than
in the window — with the switch offering only the panels its `panels=` asked for.
`controls=none` is the exception: with no bar there is no switch, so such a frame
stacks everything it was given rather than hiding a panel it could not bring back.

### Settings Panel

**FILES** — BIOS ROM, **Keypad Card ROM**, and a binary at an address. The Keypad
Card ROM row is how a freshly built `KC Monitor.bin` gets tested without burning
an AT28C64; it is the machine's own firmware rather than a cartridge, which is
why it lives here and not on the toolbar.

**MACHINE** — whether the Serial Card is installed in `io5`. Unfitting it is the
supported keypad-only machine, not a broken one.

**ACCESSORY** — which circuit is wired to `$9400`. Changing it rebuilds the slot
and warm-resets: swapping a breadboard on a running machine is not a thing you do
with the power on.

**SERIAL** — port, baud, data bits, parity, stop bits, connect. Electron picks
from the detected list; the browser opens the Web Serial picker. Bytes the
machine transmits go to the terminal *and* the real port, and bytes typed into
the terminal arrive as bytes from a port would — connect one and both views show
the same traffic.

**DEBUG SERVER** (Electron only) — starts the JSON-RPC service on a loopback port
so `6502-kim dbg` and `6502-kim attach` can drive *this* window. Off until you
start it; a shipped build never opens a socket on its own. While it runs the
panel shows the connection URL, token included, with a button to copy it —
`6502-kim dbg` and `6502-kim attach` find a local server on their own, so the
URL is for anything else that speaks the protocol.

**COMMAND LINE** (Electron only) — installs the `6502-kim` command on your
`PATH`.

No **STORAGE** and no **JOYSTICK** sections: there is no such hardware. Settings
persist; machine state does not.

---

## The Accessory Bay

`io6` — `$9400–$97FF` — is where a breadboard gets wired, and it is the address
both 6502-DOCS type-in cards write to. The bay ships with the **KIM Demo**: eight
LEDs behind a 74HC373 latch, bit 7 leftmost. A write anywhere in the window
latches the byte and lights the lamps.

**Reads return open bus**, and that is not a shortcut. A 74HC373 has no read
strobe, and a latch that read back would pass the BIOS's `ProbeGPIO` DDR test and
set `HW_GPIO` on a machine with no VIA in it.

The registry (`src/core/accessories/registry.ts`) is a built-in list rather than a
plug-in interface. An accessory is an `IO` implementation plus five fields, so
opening it up later is a decision rather than a rewrite.

---

## Command Line

`6502-kim run` boots a machine with your build output already attached — in the
desktop app, or without a window at all, with its console wired to stdin/stdout.
That covers both ends of the job: seeing a fresh build run, and having a build
script, CI run or AI agent test 6502 code end to end.

```sh
6502-kim run     # boot a KIM, optionally loaded with your build output
6502-kim dbg     # one-shot debug commands against a running emulator
6502-kim attach  # an interactive monitor session
```

The name is `6502-kim`, not `6502`: 6502-EMULATOR installs that one, both are
expected on the same machine, and they must not collide — including in
`~/.6502-kim/session.json`, where a running KIM publishes its debug port and
token.

Three ways to get the command, in order of convenience:

```sh
# 1. Installed by the app: Settings → COMMAND LINE → Install
6502-kim --version

# 2. From a checkout — always works, and what CI should use
npm run build:cli          # compiles to out/cli/
node out/cli/index.js run --help

# 3. During development
npm run cli -- run --headless --help
```

The shim works because Electron already bundles Node: it runs the app binary with
`ELECTRON_RUN_AS_NODE=1`, so **no Node runtime of your own is needed** and the CLI
can never drift from the app version — it is the same file either way.

### The shortest useful thing

```sh
printf '\x1b0800: A9 41 EA\r0800.0802\r' | 6502-kim run --headless --input-after 'ESC TO START' --max-cycles 12e6
#   KIM MONITOR v1.0
#   --ESC TO START--
#   > 0800: A9 41 EA
#   0800: 00
#   > 0800.0802
#   0800: A9 41 EA
```

The KC Monitor's serial side speaks Wozmon: `0800` examines, `0800.0810` examines
a range, `0800: A9 41` deposits, `0800 R` runs. `R` is a `JMP`, as in the
original — a program run from the serial side should end in `STP`, or be driven
from the pad instead, whose `▲` is a `JSR`.

`--input-after 'ESC TO START'` holds stdin until the splash appears. The firmware
spends its first ~1.8 M cycles probing slots and running the HD44780's four
~41 ms power-on delays, and anything sent during that is swallowed.

Wait on the splash rather than on the `>` prompt. The firmware holds at
`--ESC TO START--` and does not print a prompt until the leading `\x1b` opens the
gate — so `--input-after '>'` would sit forever waiting for output that only the
input it is holding can produce.

### With a window, or without

```sh
6502-kim run --bin 0x0800=build/counter.bin            # in the app
6502-kim run --headless --bin 0x0800=build/counter.bin # no window: a byte stream
```

The machine flags are the same either way — `--rom`, `--card-rom`, `--bin`,
`--accessory`, `--no-serial-card`, `--baud`, `--pause`, `--debug`, `--symbols`.
What differs is everything that only makes sense for one of them: `--fullscreen`,
`--detach` and `--serial <port>` for a window; `--realtime`, `--max-cycles`,
`--timeout`, `--exit-on`, `--input-after`, `--lcd` and `--json` for headless.
Flags from the wrong column are refused with the reason.

```sh
# The keypad-only machine, with the panel printed to stderr as it changes.
6502-kim run --headless --no-serial-card --lcd --max-cycles 5e6
#   +----------------+
#   |KIM MONITOR v1.0|
#   |--ESC TO START--|
#   +----------------+

# The LED breadboard on the bus, with the DOCS counter already loaded.
6502-kim run --headless --accessory led-latch --bin 0x0800=counter.bin

# A freshly built KC Monitor, without burning an AT28C64.
6502-kim run --card-rom "build/KC Monitor.bin"
```

There is no `--cart`, no `--prg`, no `--cf`, no `--nvram` and no `--rtc`. The last
one is worth its own sentence: it existed to pin the one input 6502-EMULATOR's
engine read from the host clock, and a KIM has no clock card to read one, so
**every headless run here is already reproducible**.

### Debugging a running machine

`6502-kim run --headless --debug` — or **Settings → DEBUG SERVER → Start** in the
desktop app — serves JSON-RPC over a loopback port. Every `dbg` command then needs
no arguments:

```sh
6502-kim dbg regs
6502-kim dbg mem 0x0800 32                  # spaces: cpu / ram / rom / card
6502-kim dbg disasm MonitorLoop 20          # symbols work anywhere an address does
6502-kim dbg break SerProcess --condition 'A == $52'
6502-kim dbg key 0 8 0 0                    # key an address into the monitor
6502-kim dbg key --list                     # the pad, with every encoder code
6502-kim dbg lcd                            # the two lines, as the panel shows them
6502-kim dbg send '0800: 5A\r' --wait '\r'  # over the serial console
6502-kim dbg runcycles 500000               # an exact cycle budget
6502-kim dbg state save ready.state         # snapshot the whole machine
6502-kim dbg state load ready.state         # ... and restore it in ~1 ms

6502-kim attach                             # the same commands, interactively
```

Each `dbg` invocation is a separate process that connects, calls, prints and
exits, so there is no session to manage — which is what makes this usable from a
shell script or an agent. Exit codes carry the outcome (`0` ok, `1` error, `2`
timed out, `3` no emulator, `4` breakpoint hit), and `--json` gives the raw result.

There is no `screen` family and no `input` family: this machine has a 16×2 panel
and a 24-key pad instead of a video card, a keyboard and joysticks, so `lcd` and
`key` stand where those did.

The server is **off unless asked for**, binds loopback, requires a token off
loopback, and refuses any request carrying a browser `Origin` — a loopback port is
reachable from every page the user has open. See
[docs/DEBUG-PROTOCOL.md](docs/DEBUG-PROTOCOL.md#security).

Further reading:

- **[docs/DRIVING.md](docs/DRIVING.md)** — how to drive the machine from an agent
  or a test script, written to be copied into your own 6502 project
- **[docs/DEBUG-PROTOCOL.md](docs/DEBUG-PROTOCOL.md)** — the JSON-RPC reference
- **[examples/](examples/)** — runnable scripts, exercised by CI

### Notes

- **The splash waits for `ESC`, and only `ESC`.** `--ESC TO START--` means it on
  both consoles — the pad's `ESC` key and a `\x1b` on the wire do the same thing,
  either one starts both, and no other key or byte does anything. Whatever was
  typed or pressed at the splash is discarded when the gate opens, so nothing
  sent early can execute later.
- **No prompt means no parser.** The `> ` appears only once the gate is open.
  Treat it as the ready signal it now is, and gate on the splash text if you are
  the one holding back the `ESC`.
- **Don't type at a machine that hasn't booted.** Input delivered before the
  firmware has a console sits unread in the ACIA and blocks everything behind it.
  Use `--input-after <regex>`, or boot with `--pause` and buy the boot in cycles.
- **Input is paced at the serial line rate**, measured in emulated cycles rather
  than wall time, so a pasted program cannot overrun the 256-byte input buffer and
  lands at the same point in the program on any host.
- **Keys are paced too, and never released.** Give a whole sequence to one
  `dbg key` call: the encoder latches one code, and the interrupt handler's read is
  what makes room for the next.
- **`runcycles` is exact; `wait --cycles` is "at least".** Only the first belongs
  under a byte-for-byte comparison — see
  [04-deterministic-run.sh](examples/04-deterministic-run.sh).

---

## Embedding

The web build ships a second page, `embed.html`, which is the same machine sized
for an `<iframe>` on somebody else's site — no settings panel, no serial, nothing
written to disk:

```html
<iframe
  src="https://acwright.github.io/6502-KIMULATOR/embed.html?panels=lcd,keys&keys=ESC"
  width="360" height="520"
  allow="fullscreen"
  style="border: 0"
></iframe>
```

The parameters most embeds need:

| Parameter | Default | Meaning |
|---|---|---|
| `panels` | all four | Which of `terminal`, `lcd`, `keys`, `accessory` are shown |
| `bin` | — | `<address>=<url>`, raw bytes in RAM (`bin64=` carries them inline, needing no CORS) |
| `accessory` | none | What is wired to `$9400` — `led-latch`, or `none` |
| `keys` | — | A sequence keyed on the pad once the machine is up, e.g. `ESC,0,8,0,0,UP` |
| `serialcard` | `1` | `0` gives the keypad-only machine |
| `autostart` | `1` | Boot on load; `0` holds the machine until the reader clicks |
| `controls` | `minimal` | `full` \| `minimal` \| `none` |
| `keyboard` | `auto` | The on-screen keyboard: `1`, `0`, or `auto` — on for a touch-only device |

There is no `freq` — same reason as the CLI's missing `--freq` and the control
bar's missing toggle: one clock.

An embed lays itself out for the frame it is given rather than for the window, so
a phone-sized one behaves the way the app does on a phone: one panel at a time
behind a KIM / TERM / BAY switch, and the on-screen keyboard opened by itself on
a device that has no keyboard of its own.

**[docs/EMBEDDING.md](docs/EMBEDDING.md)** is the full reference: every parameter,
the inline base64 forms, CORS and CSP, sizing, the `embed.js` loader, and the
`postMessage` API for driving a frame from the surrounding page.
[examples/embed.html](examples/embed.html) is a runnable demo of all of it.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [ImageMagick](https://imagemagick.org/) + `iconutil` (macOS) — only needed to regenerate app icons

### Install

```sh
git clone https://github.com/acwright/6502-KIMULATOR.git
cd 6502-KIMULATOR
npm install
```

### Run (Electron dev)

```sh
npm run dev
```

Hot-reloads the renderer; the Electron window opens automatically.

### Run (Web dev)

```sh
npm run build:web
npm run preview:web
```

### Type-check

```sh
npm run typecheck
```

### Tests

```sh
npm test
npm run test:coverage
bash examples/run-all.sh     # the worked examples, against the real ROMs
```

The Jest suite covers the emulator core (CPU, RAM, ROM, the PIA, the keypad and
LCD attachments, the accessories), the debug layer (session, breakpoints,
disassembler, snapshots, symbols, the protocol method table and the WebSocket
implementation), the headless host, the CLI and the embed parameters. Several
suites boot the real bundled BIOS and KC Monitor rather than a stub, so a
firmware-facing regression fails them.

`examples/` holds runnable scripts rather than documentation fragments, and CI
runs them — a documented command that stops working stops the build.

### CPU conformance suites

The CPU core is shared with the [6502 Emulator](https://github.com/acwright/6502-Emulator)
project, and is checked against four test suites written by other people, for real
W65C02S silicon rather than for this emulator. They are the answer to a class of bug
that hand-written tests are bad at catching: the flag that is right in the nine cases
someone thought to write down and wrong in the tenth.

```sh
npm run test:conformance     # fetches what it needs, then runs everything
npm run fetch:conformance    # just the download
```

| Suite | What it is |
| --- | --- |
| [Tom Harte's ProcessorTests](https://github.com/SingleStepTests/ProcessorTests) (`wdc65c02` v1) | 10,000 generated cases for each of the 254 single-steppable opcodes — initial state, final state, cycle count. 2.54 million cases. |
| [Klaus Dormann's functional test](https://github.com/Klaus2m5/6502_65C02_functional_tests) | 30 million instructions of 6502 code that checks its own results. Every documented opcode and addressing mode. |
| Klaus Dormann's 65C02 extended opcodes test | The same, for everything the CMOS part added — including the undefined opcodes. |
| [Bruce Clark's decimal test](http://www.6502.org/tutorials/decimal_mode.html) | Every pair of bytes added and subtracted in decimal mode, with both carries, against independently predicted results. 131,072 cases each way. |
| AllSuiteA (HMC-6502) | Fourteen basic instruction-set tests. Narrow, but a fourth independent author. |

Suites are downloaded to `test-suites/`, which is not in the repository — Harte's is
about a gigabyte. `cc65` is needed for the decimal test, which ships as source
because which CPU it predicts results for is an assembly-time switch:

```sh
brew install cc65      # macOS; apt-get install cc65 on Debian/Ubuntu
```

They run as a separate Jest project (`jest.conformance.cjs`) and a separate CI job,
so `npm test` stays fast. **Anything that touches `src/core/CPU.ts` should be run
past `npm run test:conformance` before it is committed, and the same change made in
the other project** — the two copies of the file are kept byte-identical.

Interrupts are the exception: no suite here covers them. Harte's format cannot
express one, and Klaus's `6502_interrupt_test` — besides needing an assembler that
does not run on macOS — is deliberately tolerant about *when* an interrupt arrives,
so it cannot settle the timing questions anyway. `src/tests/Interrupts.test.ts`
covers that ground by hand instead: 23 tests over the pushed frame, the stack, the
masking rules, level-triggered re-entry, nesting and the sampling rule. Its last
test records the one remaining known divergence — up to one instruction of extra
interrupt latency when a device raises the line mid-instruction — and explains what
fixing it would cost.

---

## Build & Distribution

```sh
npm run build        # compile TypeScript + bundle renderer
npm run dist:mac     # dist/6502-kimulator-<version>-mac-arm64.dmg (notarized)
npm run dist:win     # dist/6502-kimulator-<version>-win-x64.exe   (needs Wine)
npm run dist:linux   # AppImage + .deb                             (needs Docker)
npm run build:web    # output → dist/web/
npm run icons        # reads build/6502.png, writes build/icon.icns|ico|png
```

Two entry points land in `dist/web/`: `index.html` (the full emulator) and
`embed.html` (the [embeddable](#embedding) one). Both are deployed together, by
GitHub Actions, on every push to `main` (workflow: `.github/workflows/deploy.yml`).

---

## Project Structure

```
src/
  core/          Emulator engine (CPU, RAM, ROM, PIA, keypad, LCD, accessories)
                 — no browser or Node dependencies
  debug/         Platform-agnostic debug layer:
                   Session + Scheduler — own execution and pacing
                   Breakpoints, Disassembler, Snapshot, Symbols, Expression
                   server/ — JSON-RPC method table, WebSocket, HTTP, lock file
  host/headless/ Windowless host; wires the console to a byte stream
  cli/           `6502-kim` command line — run, dbg, attach
  main/          Electron main process (serial, ROMs, settings, debug bridge, shim)
  preload/       contextBridge — exposes window.api to the renderer
  renderer/      Vue 3 UI (shared by Electron and web builds; the web build has
                 two entry points — index.html and embed.html)
  shared/        Types, IPC channel constants, AppApi interface
docs/            DRIVING.md (agent recipes), DEBUG-PROTOCOL.md, EMBEDDING.md,
                 AGENTS.md (working notes for this repository)
examples/        Runnable worked examples, exercised by CI
assets/roms/     Bundled BIOS.bin and KCMonitor.bin (Electron extraResources)
bin/             `6502-kim` CLI entry point
build/           electron-builder resources (icons, gen-icon.mjs)
scripts/         dist-win.sh, dist-linux.sh
```

Nothing in `core/` or `debug/` imports a browser or Node built-in, which is what
lets the same engine and the same debug protocol run in a bare Node process, in an
Electron renderer, and in a browser tab.

The two bundled ROMs are build artifacts of other repositories and are **never
edited here** — [assets/roms/README.md](assets/roms/README.md) records which
commit each came from.

---

## Related

- [6502-KIM](https://github.com/acwright/6502-KIM) — the hardware this emulates, and the KC Monitor firmware
- [A.C. Wright 6502 Hardware](https://github.com/acwright/6502-ACE) — the index of the whole family
- [6502-EMULATOR](https://github.com/acwright/6502-EMULATOR) — the emulator for the rest of the family; this one's origin
- [6502-BIOS](https://github.com/acwright/6502-BIOS) — firmware source; the bundled BIOS is built from it
- [6502-PRG](https://github.com/acwright/6502-PRG) / [6502-ASM](https://github.com/acwright/6502-ASM) — templates and example programs to assemble and load
- [bin2woz](https://github.com/acwright/bin2woz) — converts a binary into a Wozmon serial upload, which the Paste box takes as-is
- [6502-DOCS](https://github.com/acwright/6502-DOCS) — the documentation site, including [the KIM chapter](https://acwright.github.io/6502-DOCS/addons/kim) and [the keypad map](https://acwright.github.io/6502-DOCS/reference/keypad-map)

### The family

| Project | Description |
|---------|-------------|
| [6502-ACE](https://github.com/acwright/6502-ACE) | All-in-one Computer Experience — a single board computer |
| [6502-COB](https://github.com/acwright/6502-COB) | Computer On a Backplane — modular desktop computer with card slots |
| [6502-DEV](https://github.com/acwright/6502-DEV) | Development Environment Vehicle — emulation-based dev system |
| [6502-KIM](https://github.com/acwright/6502-KIM) | Keypad Input Monitor — KIM-1 inspired minimal computer (**this one**) |
| [6502-VCS](https://github.com/acwright/6502-VCS) | Video Computer System — cartridge-based retro gaming console |

---

## Credits

- CPU implementation adapted from [OneLoneCoder's olcNES](https://github.com/OneLoneCoder/olcNES)
- The HD44780 controller and the 74C922 encoder come forward from 6502-EMULATOR's own history, where they were written for the VIA-attached versions of the same parts

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

This project pairs with the hardware and firmware linked above. Contributions, issues, and feature requests are welcome!
