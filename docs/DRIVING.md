# Driving the emulator from an agent

This file is written to be **copied into your own 6502 project** — into its
`AGENTS.md` or `CLAUDE.md`, or kept beside it — so that an agent working on KIM
code knows how to test that code on a real emulated machine instead of writing a
throwaway simulator.

The full method reference is [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md), and
[../examples/](../examples/) holds the same recipes as scripts that CI runs.
Every command below was run against a real machine as it was written.

---

## What you get

A complete **AC6502 KIM** — 65C02, 32 KB RAM, the family BIOS, a 6551
ACIA on the Serial Card, and the Keypad Card that overlays the top of the map
with a 65C21 PIA, a 16×2 HD44780 and its own 8 KB ROM holding the **KC
Monitor** — that you can boot, drive, inspect and assert on from a shell.

Two independent ways in, exactly as on the bench:

- **The serial console.** With the Serial Card fitted, the KC Monitor prints its
  banner and its `>` prompt to the ACIA and takes Wozmon-syntax commands back.
  Headless, stdin and stdout *are* that port.
- **The pad and the glass.** Twenty-four keys and two lines of sixteen
  characters, reachable over the debug protocol as `keypad.press` and `lcd.*`,
  whether or not there is a Serial Card in the machine.

Three properties make it usable as a test target rather than a toy:

- **The console is a byte stream.** You get the machine's actual output, in
  order, with no screen scraping.
- **It is deterministic, with nothing to configure.** Nothing in this machine
  reads the host clock — there is no clock card to read — so the same ROMs, the
  same input and the same cycle budget land in the same state every time.
  (6502-EMULATOR needs `--rtc` for this. A KIM does not.)
- **It is fast, and can skip its own boot.** Millions of emulated cycles a
  second unpaced, and a snapshot turns the LCD's power-on ritual into a
  millisecond restore.

## Installing

```sh
6502-kim --version          # if the app installed the shim (Settings → COMMAND LINE)
node out/cli/index.js       # from a checkout — always works, and what CI should use
```

Substitute whichever works for `6502-kim` below. No separate npm install; the
CLI ships inside the app and Electron's bundled Node runs it, so nothing needs a
Node runtime of its own. From a checkout, build it first with
`npm run build:cli`.

The name is `6502-kim`, not `6502`: 6502-EMULATOR installs that one, both are
expected on the same machine, and they must not collide — including in
`~/.6502-kim/session.json`, which is where a running KIM publishes its debug
port and token.

---

## The shortest useful thing

One process in, one answer out. No server, no session.

```sh
printf '\x1b0800: A9 41 EA\r0800.0802\r' | 6502-kim run --headless --input-after 'ESC TO START' --max-cycles 12e6
#   KIM MONITOR v1.0
#   --ESC TO START--
#   > 0800: A9 41 EA
#   0800: 00
#   > 0800.0802
#   0800: A9 41 EA
```

Three things in that line are worth knowing:

- **`\x1b` first.** The splash reads `--ESC TO START--` and means it, on both
  consoles. ESC on the wire and ESC on the pad do the same thing, either one
  starts both, and nothing else starts either. Anything typed or pressed before
  the gate opens is discarded rather than held over.
- **`--input-after 'ESC TO START'`** holds stdin back until the splash appears.
  The firmware spends its first ~1.8 M cycles probing slots and running the
  HD44780's power-on ritual, and anything sent during it is swallowed.

  Gate on the splash, not on the prompt. The `> ` does not appear until the ESC
  above opens the gate — that is what makes a prompt on this machine mean the
  parser is running — so `--input-after '>'` would wait forever for output that
  only the input it is holding can produce.
- **`$0800`, and nowhere below it.** Low RAM belongs to the firmware, and it
  does not defend itself — see [Where your bytes may go](#where-your-bytes-may-go).

The monitor's syntax is Wozmon's: `0800` examines, `0800.0810` examines a range,
`0800: A9 41` deposits, `0800R` runs. `R` is a `JSR` here rather than Wozmon's
`JMP`, so a program ending in `RTS` returns to a fresh prompt; one ending in
`STP` halts the machine, which is what a scripted run usually wants.

## Where your bytes may go

`PROGRAM_START` is **`$0800`**, and program space runs from there to `$7FFF`.
Below it is the machine's own workspace, out of the KC Monitor's `kim.inc` —
which is the KIM's own include, not the family-wide `6502.inc`, and differs from
it exactly where it matters here:

| Range | What lives there |
|---|---|
| `$0000-$003F` | Zero page — Kernal scratch |
| `$0040-$0051` | Zero page — **the KC Monitor's own state**, address, edit mode, Wozmon parser |
| `$0052-$00FF` | Zero page — yours |
| `$0100-$01FF` | The 6502 stack |
| `$0200-$027F` | **The KC Monitor's Wozmon line buffer** — the line you are typing |
| `$0280-$02FF` | Free. `6502.inc` calls this whole page the Kernal's input ring; on a KIM that ring is never fed |
| `$0300-$03FF` | `KERNAL_VARS` — and `$0300` itself is **`IRQ_PTR`** |
| `$0400-$04FF` | **The KC Monitor's serial RX ring**, filled by its interrupt handler |
| `$0500-$07FF` | Free on a KIM — no CompactFlash, so nothing uses the sector buffer |
| `$0800-$7FFF` | Yours |

Nothing stops you writing to any of it, exactly as nothing stops you on the
bench. Depositing three bytes at `$0300` overwrites the IRQ vector, and the next
interrupt — the very next character you type at the serial port — sends the CPU
into empty RAM. What you see then is a machine that has stopped answering, with
the bytes you typed piling up unread in the ACIA. That is not the emulator
failing; it is the emulator being accurate. Put programs at `$0800`.

## Loading your build output

```sh
# Bytes at an address — a type-in card without the typing.
6502-kim run --headless --bin 0x0800=build/counter.bin --max-cycles 5e6

# With the LED breadboard wired to the accessory bus at $9400.
6502-kim run --headless --accessory led-latch --bin 0x0800=build/counter.bin

# A freshly built KC Monitor, without burning an AT28C64.
6502-kim run --headless --card-rom "build/KC Monitor.bin"
```

There is no `--cart` and no program argument. The Keypad Card **is** this
machine's cartridge and it is soldered in; `--card-rom` replaces its firmware,
which is a different thing from slotting one in.

## The machine with no Serial Card

`KC Monitor.asm` guards every ACIA access on `HW_PRESENT & HW_SC`, so a KIM with
io5 empty is a configuration the firmware supports — and the only way to test
that path.

```sh
6502-kim run --headless --no-serial-card --lcd --max-cycles 5e6
#   +----------------+
#   |KIM MONITOR v1.0|
#   |--ESC TO START--|
#   +----------------+
```

`--lcd` prints the panel to **stderr** whenever it changes, boxed so that
trailing blanks — which are a state of the machine, not padding — are visible.
stdout stays the machine's serial stream.

Such a machine has no console at all: `--exit-on` and `--input-after` are
refused, and the way in is the pad, over the debug protocol.

## Which serial card, and the jumper that can silence it

With a card fitted, it is the Serial Card by default, with `CTS EN` at ground,
as every board is built: nothing on the far end of the cable can stop it, and
you can ignore this section. `--serial-card pro` fits the Serial Card Pro
instead. `--serial-card ace` is refused, because the ACE's serial is on the ACE
board. `6502-kim dbg info` names the card only when it is not the default:

```sh
6502-kim run --headless --debug --cts cable &
6502-kim dbg info
#   headless … — serial console, 1 MHz, Serial Card (CTS EN: cable) fitted, turbo, … cycles
```

**A jumper on the cable can make the machine look dead.** With `--cts cable`, or
on the Pro, whose CTS always reaches the cable, a far end that is not asserting
CTS turns the transmitter off from reset: no banner, no echo, nothing on
stdout, while the LCD shows the splash as usual. That is what a real board does
with `CTS EN` moved, not a hang. Headless, the console asserts its lines until
told otherwise; `6502-kim dbg lines` shows the pins, and `6502-kim dbg lines
--cts off` / `--cts on` drops and restores CTS.

The KC Monitor does not wait it out. Its `SerPutc` gives up on a byte it cannot
send within about 27 ms and drops it, so the monitor stays usable from the pad
with no terminal attached. When CTS comes back, the one byte held in the ACIA
goes out and what the monitor said meanwhile is gone; it answers the next thing
it is sent. A program that prints through the Kernal's `Chrout` waits instead,
and loses nothing. So do not gate a script on the banner after moving a jumper:
send something and wait for the reply.

## Driving the pad

Start a machine that serves the protocol, then key it:

```sh
6502-kim run --headless --debug --timeout 5m --quiet &
until 6502-kim dbg info >/dev/null 2>&1; do sleep 0.1; done

6502-kim dbg key ESC             # start the monitor
6502-kim dbg key 1 2 3 4         # key an address, nibble at a time
6502-kim dbg lcd
#   +----------------+
#   |---$1234: $00---|
#   |----------------|
#   +----------------+
```

- A **bare number is a name**, not a code. `key 0` presses the zero key; the
  encoder reports `$0A` for it, and `C`–`F` run backwards, so nothing may derive
  one from the other. `key '$0A'` says the same thing by code, and
  `6502-kim dbg key --list` prints the whole pad.
- **Give a sequence to one call.** `key 1 2 3 4` paces the presses in emulated
  cycles, because the 74C922 latches one code at a time and the monitor's
  interrupt handler reading it is what makes room for the next. Four separate
  processes would lose three keystrokes.
- **There is no release.** The encoder reports the press and nothing else.

## Debugging a program

```sh
6502-kim run --headless --debug --pause --symbols "KC Monitor.lst" --quiet &
until 6502-kim dbg info >/dev/null 2>&1; do sleep 0.1; done

6502-kim dbg break MonitorLoop       # by name, in the card's own ROM
6502-kim dbg run
6502-kim dbg key ESC                 # the splash holds for ESC; nothing else runs
6502-kim dbg wait --stopped --timeout 10s
#   breakpoint #1 at $E062
6502-kim dbg regs
6502-kim dbg disasm
6502-kim dbg mem 0x0800 16
```

`--pause` means *not started*: the machine sits on its reset vector — read out
of the Keypad Card, not the BIOS — until a client resumes it, which is how a
debugger sees the first instruction.

`--symbols` reads a VICE label file, a ca65 `.dbg`, **or a ca65 `.lst`**. That
last one matters here: `cl65 -l` is what builds `KC Monitor.bin`, and it emits a
listing and no `.dbg`, so without it the ROM a KIM session spends most of its
time in is the one with no symbols.

Memory spaces: `--space cpu` (the default, and the only one that resolves symbol
names), `ram`, `rom`, and `card` — the Keypad Card's 8 KB, offset from `$E000`,
so its reset vector is at offset `$1FFC`.

## Restore instead of rebooting

Booting costs about 1.8 M cycles before the splash appears, almost all of it the
HD44780's four ~41 ms software delays. Pay it once:

```sh
# Once
6502-kim dbg key ESC && 6502-kim dbg state save ready.state

# Per test case
6502-kim dbg state load ready.state
6502-kim dbg key 0 8 0 0
```

A snapshot records the machine's shape as well as its contents, so one taken
with the LEDs fitted refuses to restore into an empty bay, and one taken by
6502-EMULATOR is refused outright — the format string is `6502-kim-snapshot`.

## Waiting, not sleeping

Never `sleep` and hope. Every wait is measured in emulated cycles or in output,
and reports whether it matched:

```sh
6502-kim dbg send '0800: 5A\r' --wait '\r' --timeout 5s
6502-kim dbg wait --expression '[$0800] == $5A' --timeout 5s
6502-kim dbg wait --stopped --timeout 30s
6502-kim dbg runcycles 500000            # exact, from a paused machine
6502-kim dbg wait --cycles 500000        # at least that many, then the chunk ends
```

`send --wait` waits from the position in the output stream where its own write
landed, so a reply that arrives before the wait is set up still counts. In turbo
that is not a rare race, it is the normal case.

**What you get back is everything that arrived, plus where the match ended.** A
wait returns the console output as it came, so nothing that followed the match in
the same flush is taken away from you. `--json` gives you two positions with it:
`matchEnd`, the index in that transcript where the pattern matched — slice there
if you want the same transcript every run rather than however much of the line
the host happened to flush — and `cursor`, the stream position the transcript
ends on. Hand `cursor` to the next call as `--since` and you get everything the
machine printed in between, with nothing lost and nothing repeated.

```sh
first=$(6502-kim dbg send '0800\r' --wait 'EA' --timeout 5s --json)
at=$(printf '%s' "$first" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"])')

# The rest of that line and the prompt after it, with no gap from the first call.
6502-kim dbg wait --serial '\\' --since "$at" --timeout 5s
6502-kim dbg send '0801\r' --wait '\\' --since "$at" --timeout 5s   # or carry on typing
```

Without `--since`, a wait looks back only as far as its own write, which is right
for "send this, wait for its reply" and wrong for picking up where a previous call
stopped.

`wait --stopped` answers with the stop the machine is already sitting on, for
the same reason: the breakpoint fired while the previous command's process was
exiting. Adding `--run turbo` means *continue* — but only once you have been
told what you are continuing from, so the same command is safe either way. The
first `wait --stopped --run turbo` after a breakpoint or watchpoint fires
returns it; the next one runs on to the following stop.

**`wait --serial` looks back to that same position and no further**, which is the
other half of the same rule and the one that surprises people. A script that
launches a machine and *then* waits for its banner waits forever: the banner was
printed 50 ms ago, and nothing was written for the wait to look back from. Boot
with `--pause` and buy the boot in cycles instead:

```sh
6502-kim run --headless --debug --pause --quiet &
6502-kim dbg runcycles 3000000           # slot probes + the LCD's power-on ritual
6502-kim dbg key ESC                     # a single press is allowed while paused
6502-kim dbg run
```

`runcycles` is the exact one and `wait --cycles` is not: the second stops at the
first execution-chunk boundary past the budget, and how much a chunk covers is
wall-clock business. Reach for `runcycles` whenever two runs have to match byte
for byte, and for `wait` when the point is just to let the machine get on with
it. The pad has the same split — a keyed sequence is paced in emulated time but
delivered one key per chunk, whereas a single press into a paused machine lands
exactly where you put it.

`\r`, `\n`, `\t` and `\xNN` in a `send` argument are turned into the bytes they
name, because a shell string cannot hold a real carriage return or a real ESC.

## Exit codes

Branch on these rather than scraping text.

| Code | Means |
|---|---|
| 0 | ok — the run finished, or the wait matched |
| 1 | usage error, or the RPC call failed |
| 2 | timed out (`run`, `wait`, `send --wait`) |
| 3 | no emulator found — nothing at `~/.6502-kim/session.json` and none at `--port` |
| 4 | a breakpoint or watchpoint fired (`step`, `runto`, `runcycles`) |
| 130 | interrupted |

`run --headless` exits 0 when it meets its cycle budget or its `--exit-on`, and
0 when the program executes STP — a program that halted did what it was written
to do, and reporting that as a timeout would fail a passing CI job.

## A worked loop

```sh
#!/usr/bin/env bash
set -euo pipefail

# One machine, one boot, driven from the pad.
6502-kim run --headless --debug --pause --accessory led-latch \
  --bin 0x0800=build/counter.bin --timeout 2m --quiet &
emulator=$!
trap 'kill $emulator 2>/dev/null || true' EXIT

until 6502-kim dbg info >/dev/null 2>&1; do sleep 0.1; done
6502-kim dbg runcycles 3000000
6502-kim dbg key ESC
6502-kim dbg run
6502-kim dbg state save ready.state

# Per case: restore, key an address in, look at the glass.
for address in "0 8 0 0" "1 2 3 4"; do
  6502-kim dbg state load ready.state
  # shellcheck disable=SC2086
  6502-kim dbg key $address
  6502-kim dbg lcd
done

6502-kim dbg shutdown
```

## What this machine does not have

A script ported from 6502-EMULATOR will reach for these and should be told why
they are absent rather than left wondering:

| Missing | Instead |
|---|---|
| `screen text` / `screen png` | `lcd`, `lcd hash`, `lcd pixels` — 16×2, no framebuffer to encode |
| `input key` / `joystick` / `type` | `key` — the pad is the only input, and it reports presses |
| `load cart` / `unload cart` | `load card-rom` — the card is the cartridge, and it is soldered in |
| `--freq` | Nothing. PHI2 is 1 MHz; the ACE has the 2 MHz jumper |
| `--rtc` | Nothing. No clock card, so every run is already reproducible |
| `--cf`, `--nvram`, `--prg` | Nothing. No storage, no NVRAM, no BASIC — a KIM loses its RAM when you switch it off |
