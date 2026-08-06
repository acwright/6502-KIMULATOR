# Driving the emulator from an agent

This file is written to be **copied into your own 6502 project** — into its
`AGENTS.md` or `CLAUDE.md`, or kept beside it — so that an agent working on KIM
code knows how to test that code on a real emulated machine instead of writing a
throwaway simulator.

The full method reference is [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md). Worked
scripts land in `examples/` in phase 9; every command below was run against a
real machine as it was written.

---

## What you get

A complete A.C. Wright **6502-KIM** — 65C02, 32 KB RAM, the family BIOS, a 6551
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
printf '\x1b0800: A9 41 EA\r0800.0802\r' | 6502-kim run --headless --input-after '>' --max-cycles 12e6
#   KIM MONITOR v1.0
#   >
#   0800: A9 41 EA
```

Three things in that line are worth knowing:

- **`\x1b` first.** The splash reads `--ESC TO START--` and means it. ESC on the
  wire and ESC on the pad do the same thing.
- **`--input-after '>'`** holds stdin back until the prompt appears. The
  firmware spends its first ~1.8 M cycles probing slots and running the
  HD44780's power-on ritual, and anything sent during it is swallowed.
- **`$0800`, and nowhere below it.** Low RAM belongs to the firmware, and it
  does not defend itself — see [Where your bytes may go](#where-your-bytes-may-go).

The monitor's syntax is Wozmon's: `0800` examines, `0800.0810` examines a range,
`0800: A9 41` deposits, `0800R` runs.

## Where your bytes may go

`PROGRAM_START` is **`$0800`**, and program space runs from there to `$7FFF`.
Below it is the machine's own workspace, straight out of `BIOS.inc`:

| Range | What lives there |
|---|---|
| `$0000-$00FF` | Zero page — Kernal and BASIC scratch |
| `$0100-$01FF` | The 6502 stack |
| `$0200-$02FF` | `INPUT_BUFFER` — the 256-byte keyboard/serial ring buffer |
| `$0300-$03FF` | `KERNAL_VARS` — and `$0300` itself is **`IRQ_PTR`** |
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

## Driving the pad

Start a machine that serves the protocol, then key it:

```sh
6502-kim run --headless --debug --timeout 5m --quiet &
sleep 1

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
sleep 1

6502-kim dbg break MonitorLoop       # by name, in the card's own ROM
6502-kim dbg run
6502-kim dbg key ESC                 # the splash polls the pad; nothing else runs
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
6502-kim dbg wait --serial 'KIM MONITOR' --timeout 10s
6502-kim dbg wait --expression '[$0800] == $5A' --timeout 5s
6502-kim dbg wait --stopped --timeout 30s
```

`send --wait` waits from the position in the output stream where its own write
landed, so a reply that arrives before the wait is set up still counts. In turbo
that is not a rare race, it is the normal case.

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
6502-kim run --headless --debug --accessory led-latch \
  --bin 0x0800=build/counter.bin --timeout 2m --quiet &
emulator=$!
trap 'kill $emulator 2>/dev/null || true' EXIT

6502-kim dbg wait --serial 'KIM MONITOR' --timeout 20s
6502-kim dbg key ESC
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
