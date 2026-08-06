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
#   \x1b first        The splash reads "--ESC TO START--" and means it. ESC on
#                     the wire and ESC on the pad do the same thing.
#   --input-after '>' Holds stdin back until the prompt appears. The firmware
#                     spends its first ~1.8 M cycles probing slots and running
#                     the HD44780's power-on ritual, and anything sent during it
#                     is swallowed.
#   --json            A machine-readable result on stderr at exit, so the script
#                     asserts on a value rather than on prose.
#
# The program is LDA #$5A / STA $0900 / STP: it proves it ran by what it leaves
# in memory, and halts rather than looping so the run ends on its own.
PROGRAM='A9 5A 8D 00 09 DB'

show "printf '\\x1b0800: $PROGRAM\\r0800.0805\\r0800 R\\r' | 6502-kim run --headless --input-after '>'"

# shellcheck disable=SC2086 # $SIXTY502_KIM is a command plus arguments.
output=$(printf '\x1b0800: %s\r0800.0805\r0800 R\r' "$PROGRAM" |
  $SIXTY502_KIM run --headless --quiet --input-after '>' --timeout 30s --json \
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

say '2. Serial R is Wozmon R — a jump, not a call'

# Worth knowing before it wastes an afternoon: `XXXX R` is `JMP (XAML)`, exactly
# as in the original Wozmon, so a program ending in RTS returns to whatever the
# stack happened to hold and the prompt does not come back. The pad's ▲ *is* a
# JSR — DoUp calls through CUR_ADDR and a user RTS lands back in the monitor —
# which is why example 02 can key a program in, run it, and carry on.
#
# So: end a program run from the serial side with STP, or drive it from the pad.
show "printf '...0800: A9 5A 8D 00 09 60\\r0800 R\\r' | 6502-kim run --headless   # RTS, not STP"

# shellcheck disable=SC2086
printf '\x1b0800: A9 5A 8D 00 09 60\r0800 R\r' |
  $SIXTY502_KIM run --headless --quiet --input-after '>' --timeout 10s --json \
    > "$WORK/rts.log" 2>"$WORK/rts.json" || true

expect 'an RTS program run from the serial side' "$(json reason < "$WORK/rts.json")" timeout

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
