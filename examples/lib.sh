# Shared helpers for the worked examples.
#
# Sourced, not run. Every example is a real script that really drives a real
# machine — these examples are exercised by CI precisely so they cannot quietly
# rot into commands that no longer work.

set -euo pipefail

# The repo path always works, with or without the app installed. If you have run
# the Settings panel's "Install" action, plain `6502-kim` is the same program.
#
# The variable is SIXTY502_KIM, not SIXTY502: 6502-EMULATOR's examples use that
# name for the ACE's CLI, and both repositories are checked out on the same
# machine often enough that a shared name would eventually point one suite at the
# other's binary.
SIXTY502_KIM="${SIXTY502_KIM:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/out/cli/index.js}"

# Somewhere to put snapshots and scratch binaries.
WORK="$(mktemp -d)"
trap 'stop_emulator; rm -rf "$WORK"' EXIT

EMU_PID=""

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Echo the command being demonstrated, so reading the output of an example is
# as informative as reading its source.
show() { printf '$ %s\n' "$*"; }

# Fail loudly with the values, rather than leaving CI to say "exit 1".
expect() {
  local what="$1" got="$2" want="$3"
  if [ "$got" != "$want" ]; then
    printf '\n!! %s: expected %s, got %s\n' "$what" "$want" "$got" >&2
    exit 1
  fi
  printf '   ✓ %s = %s\n' "$what" "$got"
}

# The KC Monitor's serial side sends CRLF, as a real serial terminal does, so
# carriage returns are stripped before matching. Worth knowing rather than
# hiding: a pattern anchored with $ will not match a line that still has its CR.
expect_match() {
  local what="$1" got="$2" pattern="$3"
  got="$(printf '%s' "$got" | tr -d '\r')"
  if ! printf '%s' "$got" | grep -qE "$pattern"; then
    printf '\n!! %s: expected /%s/, got:\n%s\n' "$what" "$pattern" "$got" >&2
    exit 1
  fi
  printf '   ✓ %s matches /%s/\n' "$what" "$pattern"
}

# Start a machine serving the debug protocol, and wait until it answers.
#
# --pause means *not started*: the machine sits at the reset vector — read out of
# the Keypad Card, not the BIOS — until something calls exec.run, which is what a
# debugger attaching before boot needs. Drop it to have the KC Monitor running by
# the time this returns.
start_emulator() {
  # shellcheck disable=SC2086 # $SIXTY502_KIM is a command plus arguments.
  $SIXTY502_KIM run --headless --debug --quiet --timeout 120s "$@" \
    > "$WORK/emulator.log" 2>&1 &
  EMU_PID=$!

  for _ in $(seq 100); do
    # shellcheck disable=SC2086
    if $SIXTY502_KIM dbg info >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done

  printf '\n!! the emulator never came up. Its output:\n' >&2
  cat "$WORK/emulator.log" >&2
  exit 1
}

stop_emulator() {
  [ -n "$EMU_PID" ] || return 0
  kill "$EMU_PID" 2>/dev/null || true
  wait "$EMU_PID" 2>/dev/null || true
  EMU_PID=""
}

dbg() {
  # shellcheck disable=SC2086
  $SIXTY502_KIM dbg "$@"
}

# Pull one field out of a --json result: `dbg regs --json | json A`.
#
# Node rather than jq, because the emulator already guarantees a Node runtime
# and jq is not installed everywhere. Dotted paths work: `json stop.kind`.
json() {
  node -e '
    let text = ""
    process.stdin.on("data", (chunk) => { text += chunk })
    process.stdin.on("end", () => {
      const value = process.argv[1]
        .split(".")
        .reduce((object, key) => (object === undefined ? undefined : object[key]), JSON.parse(text))
      process.stdout.write(String(value))
    })
  ' "$1"
}

# Take a machine started with --pause from its reset vector to the monitor, and
# leave it running.
#
# The budget is cycles rather than a wait on the banner, and deliberately: it is
# exact, it works on a machine with no Serial Card, and `wait --serial` looks
# back only as far as the last thing the caller *wrote* — so a script that boots
# a machine and then waits for a banner it has already printed waits forever. In
# turbo the boot is over in about 50 ms of wall time, so it always has.
#
# 3 M cycles covers the ~1.8 M the firmware spends probing slots and running the
# HD44780's four ~41 ms power-on delays. There is no honest way to skip those —
# they are what the firmware does — which is why every example that needs the
# monitor more than once saves the machine here and restores it instead.
#
# ESC is pressed while the machine is still paused, which is allowed for a single
# key: the encoder latches the code and the firmware reads it when it next runs.
boot_to_monitor() {
  dbg runcycles 3000000 >/dev/null
  dbg key ESC >/dev/null
  dbg run >/dev/null
}
