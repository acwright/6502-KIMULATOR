#!/usr/bin/env bash
#
# One process in and out: boot a KIM, deposit a program down the serial line,
# read it back, run it, and branch on the exit code.
#
# This is the shortest useful thing the emulator does, and it needs no debug
# server and no session — stdin and stdout *are* the Serial Card's port, and the
# KC Monitor's serial side speaks Wozmon: `0800` examines, `0800.0810` examines a
# range, `0800: A9 41` deposits, `0800 R` runs.
#
# The same script also shows the machine the KC Monitor supports and the ACE has
# no equivalent of: io5 empty, no console at all, and the 16x2 panel as the only
# thing to read.

source "$(dirname "$0")/lib.sh"

say '1. Deposit, examine, run — one pipe, one process'

# Three things in that command line are load-bearing:
#
#   \x1b first        The splash reads "--ESC TO START--" and means it, on both
#                     consoles. ESC on the wire and ESC on the pad do the same
#                     thing, either one starts both, and nothing else starts
#                     either.
#   --input-after     Holds stdin back until the splash appears. The firmware
#     'ESC TO START'  spends its first ~1.8 M cycles probing slots and running
#                     the HD44780's power-on ritual, and anything sent during it
#                     is swallowed. Gate on the splash rather than on the `> `:
#                     the prompt does not appear until the ESC above opens the
#                     gate, so waiting for it waits on output that only the
#                     input it is holding can produce.
#   --json            A machine-readable result on stderr at exit, so the script
#                     asserts on a value rather than on prose.
#
# The program is LDA #$5A / STA $0900 / STP: it proves it ran by what it leaves
# in memory, and halts rather than looping so the run ends on its own.
PROGRAM='A9 5A 8D 00 09 DB'

show "printf '\\x1b0800: $PROGRAM\\r0800.0805\\r0800 R\\r' | 6502-kim run --headless --input-after 'ESC TO START'"

# shellcheck disable=SC2086 # $SIXTY502_KIM is a command plus arguments.
output=$(printf '\x1b0800: %s\r0800.0805\r0800 R\r' "$PROGRAM" |
  $SIXTY502_KIM run --headless --quiet --input-after 'ESC TO START' --timeout 30s --json \
    2>"$WORK/result.json")
status=$?

printf '%s\n' "$output"

expect_match 'the monitor announced itself' "$output" 'KIM MONITOR'
expect_match 'the deposited bytes read back' "$output" "0800: $PROGRAM"
expect 'the exit code' "$status" 0

# reason is "halted" for STP, "exit-on" for a matched pattern, "cycles" for a
# budget and "timeout" for --timeout. A program that halted did what it was
# written to do, so it exits 0 — reporting that as a timeout would fail a
# passing CI job.
reason=$(json reason < "$WORK/result.json")
expect 'why the run ended' "$reason" halted

# --json also carries the LCD, because on this machine the panel is state a
# headless run would otherwise throw away. Here it is showing the address the
# monitor was last sitting on.
printf '   the panel at exit: |%s|\n' "$(json lcd.0 < "$WORK/result.json")"

say '2. Serial R is a call, and RTS comes back to the prompt'

# `XXXX R` is a JSR through XAML, not original Wozmon's `JMP (XAML)`. Both of
# this machine's consoles run a program the same way — the pad's ▲ is a JSR too
# (DoUp calls through CUR_ADDR) — so a program that ends in RTS lands back in a
# live monitor either way, and the serial side prints a fresh prompt on return.
#
# The program below is example 1's with RTS in place of STP. Three things have
# to be true for the line after it to be answered at all: the program ran, the
# RTS returned into the parser, and the prompt reset the line buffer. If any of
# them failed the `0900` would be appended to the still-live "0800 R" and re-run
# the program instead of examining anything, and this would time out.
show "printf '...0800: A9 5A 8D 00 09 60\\r0800 R\\r0900\\r' | 6502-kim run --headless   # RTS, not STP"

# shellcheck disable=SC2086
printf '\x1b0800: A9 5A 8D 00 09 60\r0800 R\r0900\r' |
  $SIXTY502_KIM run --headless --quiet --input-after 'ESC TO START' --timeout 10s \
    --exit-on '0900: 5A' --json > "$WORK/rts.log" 2>"$WORK/rts.json"
status=$?

expect 'an RTS program run from the serial side' "$(json reason < "$WORK/rts.json")" exit-on
expect 'the exit code' "$status" 0
expect_match 'the monitor answered the line typed after the run' \
  "$(cat "$WORK/rts.log")" '0900: 5A'

# End a serial-launched program in STP instead when you want the run itself to
# stop the machine, as example 1 above does.

say '3. The machine with no Serial Card'

# KC Monitor.asm guards every ACIA access on HW_PRESENT & HW_SC, so a KIM with
# io5 empty is a configuration the firmware explicitly supports — and the only
# way to test that path. Such a machine has no console at all: the way in is the
# pad, and the way out is the glass.
show '6502-kim run --headless --no-serial-card --lcd --max-cycles 3e6'

# shellcheck disable=SC2086
$SIXTY502_KIM run --headless --quiet --no-serial-card --lcd --max-cycles 3e6 \
  > "$WORK/keypad-only.out" 2> "$WORK/keypad-only.lcd"

panel=$(cat "$WORK/keypad-only.lcd")

# One box per change, so the splash arrives a character at a time — the firmware
# writes it that way and the panel is reported as it is, not as it settles. The
# last frame is the one worth looking at.
tail -4 "$WORK/keypad-only.lcd"

expect_match 'the splash reached the panel' "$panel" 'KIM MONITOR v1.0'
expect_match 'and asked for a key' "$panel" 'ESC TO START'
expect 'nothing at all came out of the serial port' "$(wc -c < "$WORK/keypad-only.out" | tr -d ' ')" 0

# --lcd prints to stderr, boxed, whenever the panel changes: stdout stays the
# machine's serial stream, and the box makes trailing blanks — which are a state
# of the machine, not padding — visible.

say '4. Flags that cannot mean anything are refused, not ignored'

# --exit-on matches serial output, and there is none. Told, rather than left to
# time out and look like a hang.
set +e
# shellcheck disable=SC2086
message=$($SIXTY502_KIM run --headless --no-serial-card --exit-on 'KIM' --timeout 5s 2>&1)
status=$?
set -e

expect 'the exit code' "$status" 1
expect_match 'and the reason' "$message" 'no serial output to match'

say 'Example 1 passed'
