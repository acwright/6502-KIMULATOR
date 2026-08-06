#!/usr/bin/env bash
#
# Wire the LED breadboard to the accessory bus and run the type-in card on it.
#
# io6 — $9400-$97FF — is where a circuit gets wired on this machine, and the
# first thing to plug into it is the KIM Demo: eight LEDs behind a 74HC373
# latch. The program is the binary counter from
# 6502-DOCS/docs/public/cards/archive/kim-led-binary-counter.html, byte for byte
# as printed:
#
#   stz $36          64 36        zero the counter
#   lda $36          A5 36        load it
#   sta $9400        8D 00 94     put it on the LEDs
#   lda #50 / ldx #0 A9 32 A2 00  50 centiseconds
#   jsr $A075        20 75 A0     SysDelay, in the BIOS Kernal — still callable
#   inc $36          E6 36
#   bra              80 F0
#
# Two things about the latch are the point of the exercise, and both are
# hardware behaviour rather than convenience: a write lights the lamps, and a
# read comes back as open bus.

source "$(dirname "$0")/lib.sh"

COUNTER='64 36 A5 36 8D 00 94 A9 32 A2 00 20 75 A0 E6 36 80 F0'

# The counter's loop: 50 centiseconds of SysDelay, which is half a second of
# emulated time — and PHI2 here is 1 MHz, so half a million cycles per lamp.
CYCLES_PER_STEP=500000

# The latch has no read strobe, so the only honest way to read it is to ask the
# machine for its state. A snapshot carries it: `{"kind":"led-latch","latched":n}`.
latched() {
  dbg state save "$WORK/leds.state" >/dev/null
  node -e '
    const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const led = state.slots.find((slot) => slot && slot.kind === "led-latch")
    if (!led) { process.stderr.write("no LED latch in the snapshot\n"); process.exit(1) }
    process.stdout.write(String(led.latched))
  ' "$WORK/leds.state"
}

say '1. Boot with the LEDs fitted and the card already typed in'

# --bin is the type-in card without the typing. --accessory names a circuit from
# the built-in registry; a typo is a message here rather than a run that quietly
# proves nothing.
printf '%s' "$COUNTER" | node -e '
  let text = ""
  process.stdin.on("data", (chunk) => { text += chunk })
  process.stdin.on("end", () => {
    const bytes = text.trim().split(/\s+/).map((hex) => parseInt(hex, 16))
    require("fs").writeFileSync(process.argv[1], Buffer.from(bytes))
  })
' "$WORK/counter.bin"

show '6502-kim run --headless --debug --accessory led-latch --bin 0x0800=counter.bin'
start_emulator --pause --accessory led-latch --bin "0x0800=$WORK/counter.bin"

dbg info
boot_to_monitor
dbg lcd

say '2. The BIOS did not mistake the latch for a VIA'

# A 74HC373 has no read strobe, so reads come back as open bus — and that is
# what keeps the BIOS's ProbeGPIO from finding a DDR here and setting HW_GPIO on
# a machine with no VIA in it. $030D is HW_PRESENT, out of BIOS.inc.
show '6502-kim dbg mem 0x9400 4'
dbg mem 0x9400 4

expect 'a read of the latch' "$(dbg mem 0x9400 4 --json | json data)" 'AAAAAA=='
expect 'HW_PRESENT — HW_SC ($10) and nothing else' "$(dbg mem 0x030d 1 --json | json data)" 'EA=='

say '3. Run it from the pad, the way the card says to'

show '6502-kim dbg key 0 8 0 0 && 6502-kim dbg key UP'
dbg key 0 8 0 0
dbg key UP

say '4. Watch the lamps count, on an exact cycle budget'

# Pause first, then buy time in cycles rather than sleeping. Sampling a machine
# running flat out would read whatever the host's speed happened to reach; a
# cycle budget reads the same value on every host and in CI.
dbg pause >/dev/null

# Where the count had got to when the pause landed is wall-clock business, so
# the assertions are relative to it. Everything after the pause is not: each
# budget below advances the lamps by exactly one, on any host.
lamps() {
  node -e '
    const bits = Number(process.argv[1]).toString(2).padStart(8, "0")
    process.stdout.write([...bits].map((bit) => (bit === "1" ? "*" : ".")).join(""))
  ' "$1"
}

first=$(latched)
printf '   the lamps are showing $%02X  %s\n' "$first" "$(lamps "$first")"

for step in 1 2 3; do
  dbg runcycles "$CYCLES_PER_STEP" >/dev/null
  value=$(latched)
  printf '   after %d x %d cycles: $%02X  %s\n' "$step" "$CYCLES_PER_STEP" "$value" "$(lamps "$value")"
  expect "count after step $step" "$value" "$((first + step))"
done

say '5. The accessory survives a snapshot round-trip'

# The snapshot records what is fitted as well as what it holds, so one taken
# with the LEDs in refuses to restore into an empty bay — a test that thinks it
# is driving a breadboard cannot silently be driving nothing.
before=$(latched)
dbg state save "$WORK/counting.state" >/dev/null
dbg runcycles $((CYCLES_PER_STEP * 4)) >/dev/null
dbg state load "$WORK/counting.state" >/dev/null

expect 'the lamps after the round-trip' "$(latched)" "$before"

stop_emulator

show '6502-kim run --headless --debug   # no --accessory: an empty bay'
start_emulator
set +e
message=$(dbg state load "$WORK/counting.state" 2>&1)
status=$?
set -e

expect 'restoring an LED snapshot into an empty bay' "$status" 1
expect_match 'and the reason' "$message" 'slot'

say 'Example 3 passed'
