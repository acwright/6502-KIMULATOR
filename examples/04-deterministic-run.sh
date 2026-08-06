#!/usr/bin/env bash
#
# Make a run reproducible, so an emulator-based test can be trusted in CI.
#
# On a KIM this needs no flag at all. The engine is driven entirely by cycle
# accumulators, and unlike its sibling this machine has **no clock card** —
# nothing in it reads the host's clock, so there is no host state to pin.
# 6502-EMULATOR needs `--rtc` for what this script gets for free, and the reason
# it needs one is exactly the card a KIM does not have.
#
# What still has to be got right is *how time is bought*, and the two ways of
# buying it are not the same:
#
#   runcycles n          Exactly n cycles, from a paused machine. The primitive
#                        a reproducible test is built on.
#   wait --cycles n      At least n, checked between execution chunks — and how
#                        much a chunk covers is wall-clock business. Right for
#                        "let it get on with it", wrong for a byte comparison.
#
# The pad has the same split. A sequence in one call is paced in emulated time,
# but delivered one key per chunk, so where the presses land depends on the host.
# One key at a time into a paused machine, each followed by its own budget, is
# exact — and a single press is allowed on a paused machine precisely because the
# encoder latches it and the firmware reads it when it next runs.

source "$(dirname "$0")/lib.sh"

BOOT_CYCLES=3000000
PER_KEY_CYCLES=200000

# One run: an exact boot budget, then a keyed sequence with an exact budget
# behind each press, then the machine as it stands.
snapshot_at_budget() {
  local out="$1"
  shift
  start_emulator --pause "$@"
  dbg runcycles "$BOOT_CYCLES" >/dev/null
  for key in ESC 0 8 0 0; do
    dbg key "$key" >/dev/null
    dbg runcycles "$PER_KEY_CYCLES" >/dev/null
  done
  dbg state save "$out" >/dev/null
  stop_emulator
}

# The snapshot minus the fields that are *meant* to differ: when it was taken.
canonical() {
  node -e '
    const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    delete state.createdAt
    process.stdout.write(JSON.stringify(state))
  ' "$1"
}

cycles_of() {
  node -e '
    const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    process.stdout.write(String(state.cycles))
  ' "$1"
}

say '1. Two runs on the same cycle budget, keyed the same way'

show '6502-kim run --headless --debug --pause   # then: runcycles, key, runcycles, ...'
snapshot_at_budget "$WORK/a.state"
snapshot_at_budget "$WORK/b.state"

if [ "$(canonical "$WORK/a.state")" = "$(canonical "$WORK/b.state")" ]; then
  printf '   ✓ byte-identical machines — CPU, RAM, the PIA, the LCD controller and all\n'
else
  printf '\n!! the two runs diverged\n' >&2
  exit 1
fi

# And the budget was met exactly, which is the property the comparison rests on.
expect 'cycles spent' "$(cycles_of "$WORK/a.state")" \
  "$((BOOT_CYCLES + PER_KEY_CYCLES * 5))"

say '2. The same, in three different host timezones'

# Nothing here reads a clock, so there is nothing for TZ to reach. This is the
# check that fails on a machine with an RTC card and no --rtc.
for zone in UTC Asia/Tokyo America/Chicago; do
  TZ="$zone" snapshot_at_budget "$WORK/tz-$(echo "$zone" | tr / -).state"
done

first=$(canonical "$WORK/tz-UTC.state")
for zone in Asia/Tokyo America/Chicago; do
  if [ "$(canonical "$WORK/tz-$(echo "$zone" | tr / -).state")" != "$first" ]; then
    printf '\n!! TZ=%s produced a different machine\n' "$zone" >&2
    exit 1
  fi
  printf '   ✓ TZ=%s matches UTC\n' "$zone"
done

say '3. With the LED breadboard fitted, which has state of its own'

snapshot_at_budget "$WORK/led-a.state" --accessory led-latch
snapshot_at_budget "$WORK/led-b.state" --accessory led-latch

if [ "$(canonical "$WORK/led-a.state")" != "$(canonical "$WORK/led-b.state")" ]; then
  printf '\n!! the two accessory runs diverged\n' >&2
  exit 1
fi
printf '   ✓ byte-identical, latch included\n'

# The two shapes are different machines, and the snapshot says so — which is what
# stops a test restoring a session onto a machine that is not the one it came
# from.
if [ "$(canonical "$WORK/led-a.state")" = "$first" ]; then
  printf '\n!! a machine with an accessory should not match one without\n' >&2
  exit 1
fi
printf '   ✓ and not equal to the machine with an empty bay\n'

say '4. wait --cycles is a different promise, and says so'

# Not a lesser one: this is what to use when the point is to let the machine get
# on with something. It just is not the thing to hang a byte comparison on,
# because it stops at the first chunk boundary past the budget and a chunk is
# however much the host got through.
start_emulator --pause
dbg wait --cycles "$BOOT_CYCLES" --run turbo >/dev/null
dbg pause >/dev/null
dbg state save "$WORK/waited.state" >/dev/null

waited=$(cycles_of "$WORK/waited.state")
printf '   asked for %s cycles, stopped at %s\n' "$BOOT_CYCLES" "$waited"

if [ "$waited" -lt "$BOOT_CYCLES" ]; then
  printf '\n!! wait --cycles returned early\n' >&2
  exit 1
fi
printf '   ✓ at least the budget, and not exactly it — by design\n'

say '5. Conditions, not sleeps'

# The other way to be reproducible is to wait on a fact about the machine rather
# than on time at all. Same expression language the breakpoint conditions use.
show "6502-kim dbg wait --expression '[\$0300] != 0' --timeout 5s"
matched=$(dbg wait --expression '[$0300] != 0' --timeout 5s --run turbo --json | json matched)
expect 'the Kernal set up its IRQ vector' "$matched" true

say 'Example 4 passed'
