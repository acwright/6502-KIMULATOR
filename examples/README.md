# Worked examples

Runnable scripts, not fragments. CI runs `run-all.sh` on every push, so a command
here that stops working stops the build rather than quietly misleading whoever
copies it out.

```sh
npm run build:cli
bash examples/run-all.sh              # everything
bash examples/03-led-counter.sh       # or just one
```

Each script asserts on what it gets back, so a pass means the emulator really did
the thing described — not merely that the command exited zero.

| Example | What it shows |
|---|---|
| [01-monitor-over-serial.sh](01-monitor-over-serial.sh) | One process in and out: deposit and run in Wozmon syntax, then the same machine with no Serial Card at all |
| [02-key-in-a-program.sh](02-key-in-a-program.sh) | The type-in card done properly — key the address, `INS`, key the bytes, `▲` to run — then name the result, break on it, and restore per case |
| [03-led-counter.sh](03-led-counter.sh) | The DOCS binary counter on the LED breadboard at `$9400`, sampled on an exact cycle budget |
| [04-deterministic-run.sh](04-deterministic-run.sh) | Byte-identical machines across runs and timezones, and which of the two ways of buying time gets you there |
| [05-raw-protocol.sh](05-raw-protocol.sh) | The same machine driven by `curl`, with no CLI — plus the security guards |

One example is not a script and CI does not run it: [embed.html](embed.html) is
the manual check for the embeddable build, since nothing about an `<iframe>`,
keyboard focus or `postMessage` can be asserted from a shell. Build the web app,
serve it, then open the page:

```sh
npm run build:web && npm run preview:web
open examples/embed.html          # or ?base=<url> for a different build
```

See [../docs/EMBEDDING.md](../docs/EMBEDDING.md) for the reference.

Everything shared lives in [lib.sh](lib.sh): starting and stopping an emulator,
taking one from its reset vector to the monitor, pulling a field out of a
`--json` result without needing `jq`, and the `expect` helpers that make a
failure say what it wanted and what it got.

To point the examples at an installed `6502-kim` instead of the repo build:

```sh
SIXTY502_KIM=6502-kim bash examples/run-all.sh
```

The variable is `SIXTY502_KIM`, not `SIXTY502`: 6502-EMULATOR's examples use that
name for the ACE's CLI, and both repositories tend to be checked out on the same
machine.

## Four notes that will save time

All four are real machine behaviour or real protocol semantics rather than
emulator quirks — see [../docs/DRIVING.md](../docs/DRIVING.md) for the rest.

- **The splash means it.** `--ESC TO START--` waits for a key, and until it gets
  one nothing else happens. ESC on the wire and ESC on the pad do the same thing.
- **Don't type at a machine that hasn't booted.** The firmware spends its first
  ~1.8 M cycles probing slots and running the HD44780's four ~41 ms power-on
  delays, and anything arriving during that is swallowed — or worse, sits unread
  in the ACIA blocking everything behind it. `--input-after '<regex>'` holds
  stdin until a prompt appears.
- **`wait --serial` looks back only as far as your last write.** That is what
  makes "wait for the reply to what I just sent" correct in turbo, where the
  reply normally lands before a wait could be set up. It also means a script that
  boots a machine and *then* waits for the banner waits forever, because the
  banner was printed 50 ms ago and nobody wrote anything. Boot with `--pause` and
  buy the boot in cycles instead — that is what `boot_to_monitor` does.
- **`runcycles` is exact; `wait --cycles` is "at least".** The second stops at
  the first execution-chunk boundary past the budget, and how much a chunk covers
  is wall-clock business. Only the first belongs under a byte-for-byte
  comparison. The same split applies to the pad: a keyed *sequence* is paced in
  emulated time but delivered one key per chunk, whereas a single press into a
  paused machine lands exactly where you put it.
