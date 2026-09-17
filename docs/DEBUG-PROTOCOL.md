# The debug protocol

A running emulator — headless or the desktop app — can serve a JSON-RPC 2.0
service on a loopback port. `6502-kim dbg` and `6502-kim attach` are clients of
it, and so is anything else that can make an HTTP request.

This document is the reference. It is a port of 6502-EMULATOR's, amended for a
machine with a keypad and a two-line LCD instead of a keyboard, a joystick and a
video card — the differences are called out where they matter, because most
readers arrive here already knowing the other one.

> This is the method-by-method reference. For how to actually drive a machine
> with it — booting one, keying the pad, waiting on output rather than sleeping —
> see [DRIVING.md](DRIVING.md).

- [Turning it on](#turning-it-on)
- [Finding it](#finding-it)
- [Transport](#transport)
- [Security](#security)
- [Conventions](#conventions)
- [Methods](#methods)
- [Notifications](#notifications)
- [Errors](#errors)
- [Differences from 6502-EMULATOR](#differences-from-6502-emulator)

---

## Turning it on

Off unless asked for. A shipped GUI never opens a socket on its own.

```sh
# Headless
6502-kim run --headless --debug
6502-kim run --headless --debug --debug-port 9000 --debug-host 127.0.0.1

# Desktop app
Settings → DEBUG SERVER → Start
```

`--pause` starts the machine stopped at its reset vector, which is how a debugger
attaches before the KC Monitor has run an instruction. It means *not started*,
not started-and-then-stopped.

## Finding it

A server publishes where to reach it, so a client needs no configuration:

```jsonc
// ~/.6502-kim/session.json — mode 0600, because it holds the token
{
  "pid": 41234,
  "host": "127.0.0.1",
  "port": 51655,
  "token": "…64 hex characters…",
  "started": "2026-08-05T18:22:04.113Z",
  "version": "1.0.0",
  "host_kind": "headless",   // or "electron"
  "cwd": "/Users/you/project"
}
```

`$SIXTY5O2_KIM_HOME` moves the directory. The lock is removed on a clean
shutdown, and a stale one left by a killed process is detected — the `pid` is
checked — so a client fails with "no running emulator" rather than timing out
against a dead port.

**`~/.6502-kim`, not `~/.6502`.** That directory belongs to 6502-EMULATOR. The
two are separate applications and a person can perfectly well run both at once;
sharing a lock would mean the second to start finds it held, or — worse — that
`6502-kim dbg` attaches to an ACE and reports its registers without either side
noticing. Same reasoning as the CLI being named `6502-kim`.

Only one KIMulator can own the lock. For a second, pass `--debug-port` when
launching and `--port` when connecting.

## Transport

Two shapes on one port, for two kinds of caller.

**`POST /rpc`** — one-shot. This is what an agent wants: every `6502-kim dbg`
invocation is a separate process with no session to resume, and making it
complete a WebSocket handshake to ask for the registers would be ceremony.

```sh
curl -X POST http://127.0.0.1:51655/rpc \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"reg.get"}'
```

**WebSocket** on the same port — for anything that stays attached, because only a
connection can receive [notifications](#notifications). Node has shipped a
standards `WebSocket` client since v22, so a client needs no dependency:

```js
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`)
```

The token goes in the query string there because the WHATWG WebSocket API cannot
set request headers. On connect the server immediately sends an `attached`
notification carrying the protocol version, so a client learns what it is talking
to without a round trip.

Batches work: send an array, get an array back. Requests without an `id` are
notifications — they run, and nothing is returned, not even on failure.

## Security

The desktop app opens a listening socket, so this is not optional.

| Guard | Behaviour |
|---|---|
| Bind address | `127.0.0.1` unless `--debug-host` says otherwise |
| Token | Generated per session, published in the lock file. Required on any non-loopback bind; optional from loopback, where anything that could read the token could equally attach a debugger to the process |
| `Origin` | **Any request carrying one is refused** unless explicitly allowed |
| `Content-Type` | Must be `application/json` |
| Body size | Capped; a larger body is refused before being buffered |
| Off by default | `--debug`, or the Settings toggle |

The `Origin` and `Content-Type` rules are the load-bearing pair, and they are
about the browser rather than the network. A loopback port is reachable from every
page the user has open, and a page can fire a cross-origin POST whose reply it
never needs to read — enough to call `mem.write`. `application/json` is the one
content type a page cannot set cross-origin without a preflight, which this server
never answers.

Note what the protocol deliberately does expose: `mem.write` and `media.load*`
alter the machine, and `mem.write {space:'card'}` rewrites the firmware. Loopback,
opt-in and a token is the right posture for that; exposing it beyond the machine
is a deliberate act. There is no CF image here to read files off, which makes the
exposure smaller than the ACE's — but not small enough to be casual about.

## Conventions

**Addresses.** Anywhere an address is accepted, all of these work — `57344`,
`"$E000"`, `"0xE000"`, and a symbol name once `sym.load` has run.

**Bytes.** Base64 on the wire. `mem.write` and friends also accept a plain array
of numbers, so a shell one-liner stays writable by hand.

**Memory spaces.** `mem.*` takes a `space`:

| Space | What it is |
|---|---|
| `cpu` | The 64K the processor sees, through the address decode — so it obeys the Keypad Card's overlay and reads the PIA's registers as the program would. Wraps at 64K. Default. |
| `ram` | The 32K RAM chip directly. Agrees with `cpu` below `$8000`. |
| `rom` | The BIOS image, offset from `$8000`. **Writable.** |
| `card` | The Keypad Card's 8K, offset from `$E000`. **Writable.** |

The two image spaces are not conveniences. Writes through the CPU space are
ignored above `$8000`, exactly as on the hardware, so patching an image is the
only way to try a fix without rebuilding — and for the Keypad Card that is the
common case rather than the exotic one, since the KC Monitor is the firmware
under development here.

`rom` also reaches what the CPU cannot. Above `$C000` the card overlays the
BIOS, so `$C000`–`$FFFF` of `BIOS.bin` is not on this machine's bus at all and is
readable only through `rom`. A `cpu`-space read of `$E000` answers out of the
card, which is the decode working correctly and not what someone inspecting the
BIOS image asked for.

The image spaces refuse an offset past their end rather than wrapping: running off
the end of the card is a mistake, and silently reading from the start would hide
it.

**A debugger's own reads do not fire watchpoints.** `mem.read` goes around the bus
taps, so inspecting the address a watchpoint covers does not stop the machine.

**Emulated time, not wall time.** `wait.for` conditions are evaluated on the
machine's own execution cadence, so `cycles` and `expression` land at the same
point in a program however fast the host is. `keypad.press` paces on the same
clock, for a sharper reason — see [keypad](#keypad).

---

## Methods

### session

| Method | Params | Returns |
|---|---|---|
| `session.info` | — | `protocol`, `host`, `version`, `console`, `frequency`, `baudRate?`, `flowControl`, `serialCard`, `symbols`, plus [run state](#run-state) |
| `session.reset` | `cold?` (default `true`) | Run state |
| `session.config` | `baudRate?`, `flowControl?` | `frequency`, `baudRate?`, `flowControl`, `console` |
| `session.shutdown` | — | `{ok:true}`, then the host winds down |

`frequency` is reported and not settable. PHI2 on this board is 1 MHz; the ACE
is the machine in the family whose board carries the 2 MHz jumper.

`console` is `serial` or `keypad`. `keypad` is not a lesser mode — it is the
machine with io5 vacant, and the KC Monitor guards every ACIA access on
`HW_PRESENT & HW_SC`, so it is a configuration the firmware explicitly supports.
On such a machine every `serial.*` method reports `NOT_SUPPORTED`.

`serialCard` is where 6502-EMULATOR reports `cartridge`. There is no cartridge to
report: the Keypad Card *is* the cartridge and it is soldered in.

`session.shutdown` answers before exiting, so the caller sees a result rather
than a dropped socket.

<a name="run-state"></a>Most methods return the machine's run state alongside
their own result: `mode` (`paused`/`realtime`/`turbo`), `running`, `cycles`, and
`registers` (`A X Y PC SP P`, plus `flags` broken out).

### exec

| Method | Params | Returns |
|---|---|---|
| `exec.state` | — | Run state |
| `exec.run` | `mode?` — `realtime` or `turbo` (default) | Run state |
| `exec.pause` | — | `stop` + run state |
| `exec.step` | `kind?` — `instruction` (default), `cycle`, `over`, `out`; `count?` | `stop` + run state |
| `exec.runCycles` | `cycles` | `stop` + run state |
| `exec.runTo` | `address`, `mode?`, `timeoutMs?` | `stop` + run state |

`stop` is one of:

```jsonc
{ "kind": "paused" }
{ "kind": "step" }
{ "kind": "cycle-budget", "cycles": 50000 }
{ "kind": "breakpoint",  "id": 1, "address": 57344 }
{ "kind": "watchpoint",  "id": 2, "address": 1024, "access": "write" }
{ "kind": "trap", "detail": "…" }
{ "kind": "trap", "detail": "stp" }
```

`detail: "stp"` is the machine halting itself: the CPU executed `STP`, which
stops its clock until a RESET. The scheduler pauses, and `exec.run` or
`exec.step` from there returns the same stop again — `session.reset` is what makes
the machine runnable. The I/O cards keep ticking meanwhile, as they do on the
real board, where PHI2 comes from the oscillator rather than the CPU. `WAI` is
*not* a stop: the machine is live and waiting for an interrupt.

`exec.runTo` on the address the PC already sits at runs a full lap rather than
returning immediately, so run-to-cursor inside a loop does something useful. It
removes its temporary breakpoint however it exits.

`step over` and `step out` track call depth across `JSR` and `RTS`/`RTI`. Hand-rolled
stack manipulation can desynchronise that, so they are bounded and report a
`trap` rather than hanging.

**Turbo is worth knowing about on this machine in particular.** `LcdInit` runs
the HD44780 power-on ritual with four ~41 ms software delays in it, so reaching
the KC Monitor's splash costs about 1.8 million clock cycles. In turbo that is a
fraction of a second; in realtime it is the two seconds it takes on the bench.
Better still, boot once and use [`state.save`](#state).

### bp

| Method | Params | Returns |
|---|---|---|
| `bp.set` | `address`, `kind?` (`exec` default, `read`, `write`, `access`), `end?`, `condition?`, `ignoreCount?`, `temporary?`, `enabled?` | The breakpoint |
| `bp.clear` | `id?` — omit to clear all | `{cleared: n}` |
| `bp.list` | — | `{breakpoints: [...]}` |
| `bp.enable` / `bp.disable` | `id` | The breakpoint |

A breakpoint stops *before* the instruction at its address. `end` makes a
watchpoint cover a range.

**Conditions** are a small expression language, evaluated only after an address
has already matched — so their cost never touches the hot path:

```
A == $FF
X != 0 && [$0400] > 10
PC >= MonitorLoop
{$0300} == $E000        // a 16-bit little-endian read, for a pointer
```

Registers `A X Y PC SP P ST`; `[expr]` reads a byte, `{expr}` a word; `$`/`0x`
hex, bare digits decimal; the usual arithmetic, comparison, bitwise and logical
operators. Bare identifiers resolve as symbols.

A watchpoint on `$C000` is a useful thing on this machine: it is the PIA's
`PORTA`, so it fires every time the firmware reads the keypad.

**An emulator with nothing armed runs exactly as fast as one that has never heard
of breakpoints** — execution breakpoints live in a 64K bitmap and watchpoint bus
taps are attached only while a watchpoint exists.

### reg

| Method | Params | Returns |
|---|---|---|
| `reg.get` | — | `A X Y PC SP P`, `flags` |
| `reg.set` | any of `A X Y SP P PC` | The registers |

Setting `PC` abandons the instruction in flight, so the next tick does not finish
the old one against the new address.

### mem

| Method | Params | Returns |
|---|---|---|
| `mem.read` | `space?`, `address`, `length?` (default 1) | `space`, `address`, `length`, `data` (base64) |
| `mem.write` | `space?`, `address`, `data` | `written` |
| `mem.fill` | `space?`, `address`, `length`, `value` | `written` |
| `mem.search` | `space?`, `pattern`, `start?`, `end?`, `limit?` | `matches`, `truncated` |

`mem.search`'s `pattern` takes base64, a byte array, or plain text.

### disasm

| Method | Params | Returns |
|---|---|---|
| `disasm.at` | `address?` (default PC), `count?` (default 8) | `instructions` |
| `disasm.range` | `start`, `end` | `instructions` |

Each instruction carries `address`, `bytes`, `name`, `mode`, `operand`, `target?`,
`label?`, `documented`, and a pre-rendered `text` line so a client need not
reimplement formatting. `documented` is false for an opcode the W65C02S does not
define.

### sym

| Method | Params | Returns |
|---|---|---|
| `sym.load` | `path` or `text`, `format?` (`vice`/`ca65`/`lst`), `merge?` | `format`, `loaded`, `total` |
| `sym.lookup` | `address` | `name?`, `offset?`, `file?`, `line?` |
| `sym.resolve` | `name` | `address` |
| `sym.list` | `prefix?`, `limit?` | `symbols`, `total`, `truncated` |

Three formats, and which one you want depends on which ROM you are in:

| Format | File | Where it comes from |
|---|---|---|
| `ca65` | `BIOS.dbg` | `ld65 --dbgfile`. The richest — the only one carrying source line numbers. |
| `lst` | `KC Monitor.lst` | `cl65 -l`. **New here.** The Keypad Card's firmware ships a listing and no debug file, so without this the one ROM a KIM session most wants symbols for would be the one it could not have them for. |
| `vice` | `*.lbl` | Anything: ca65, 64tass and ACME can all emit them. |

The format is inferred from the extension when not given. Loaded symbols become
usable everywhere an address is accepted, including in breakpoint conditions.

A listing needs one thing a debug file does not: it counts from the start of a
segment, and the linker's decision about where that segment lands is not in the
file. The Keypad Card's `6502.cfg` places `ROM` at `$E000` and `VECTORS` at
`$FFFA`, and those are the defaults. Two kinds of line are read differently —
a **label** takes the location counter offset by its segment, an **equate**
(`Beep := $A030`) takes its right-hand side, because the counter on an equate's
line is wherever the assembler happened to be. ca65's cheap locals are qualified
with their parent (`DoLeft@Done`), since there are a dozen `@Done`s in the ROM.
Source line numbers are not recovered; a listing does not carry the mapping.

### media

| Method | Params | Returns |
|---|---|---|
| `media.loadROM` | `path` or `data` | `bytes` + run state |
| `media.loadCardROM` | `path` or `data` | `bytes` + run state |
| `media.loadBinary` | `address`, `path` or `data` | `address`, `bytes` |

`path` is read by the *host*, which may be a packaged app in another directory —
pass `data` when that is not what you want. Loading either ROM resets the
machine.

`media.loadCardROM` stands where 6502-EMULATOR has `media.loadCart`, and is
deliberately not named like it. There is no cartridge slot on this machine and
nothing to unload into — **there is no `media.loadCart` and no
`media.unloadCart`**. This is the scripted equivalent of Settings → FILES →
Keypad Card ROM: how a freshly built `KC Monitor.bin` gets tested without burning
an AT28C64. Exactly 8192 bytes, or it is refused.

`media.loadROM` takes exactly 32768. Note that a new BIOS does *not* move where
the machine starts: `$FFFC` belongs to the Keypad Card.

There is no `media.loadProgram`. That method exists on the ACE to fix up BASIC's
end-of-program pointers, and there is no BASIC here — `media.loadBinary` puts
bytes at an address, which is what a type-in card is anyway.

### serial

The Serial Card, when io5 is fitted. On a keypad-only machine every method here
reports `NOT_SUPPORTED` — check `session.info`'s `serialCard` first.

| Method | Params | Returns |
|---|---|---|
| `serial.write` | `data`, `encoding?` (`text` default, `base64`) | `queued`, `cursor` |
| `serial.read` | `since?`, `max?`, `clear?` | `data`, `length`, `cursor`, `truncated` |
| `serial.config` | — | `console`, `baudRate?`, `flowControl`, `frequency` |

**The cursor is the important part.** It is an absolute position in the console's
output stream, and `serial.write` returns where the stream stood when the command
went out. Pass it back as `wait.for {since}` and "wait for the reply to what I
just sent" is correct with no bookkeeping — which matters because in turbo the
machine covers hundreds of thousands of cycles between two one-shot calls, and the
reply is normally printed before a wait could even be set up. `wait.for` defaults
`since` to the last write's cursor for exactly this reason.

Text writes translate `\n` to CR, because that is what a terminal sends for Enter
and what the KC Monitor's serial monitor ends a line on.

Input is paced at the serial line rate, measured in emulated cycles — so it lands
at the same point in the program whatever speed the host runs at.

`flowControl` is whether serial input honours RTS/CTS flow control. It is `true`
unless `6502-kim run --no-flow-control`, `session.config` or the app's Settings
turned it off. `session.config` can set it on a headless host; the app refuses
(`NOT_SUPPORTED`), because its Settings panel owns the setting. With it on, while
the machine holds the ACIA's RTS high — command register bits 3-2 clear and echo
mode off, which is the reset state — nothing more is sent: `serial.write` still
queues, and the queue resumes in order, at the line rate, when RTS drops. Nothing
is dropped.

**Flow control is on by default, and on the KC Monitor it holds input only until
`KernalInit`,** which writes `$09` (RTS low); the monitor's IRQ handler never
writes the command register again. It matters to a program that drives the ACIA
itself and raises RTS, which must lower it again or input stops for good — and
which must not print in the meantime, because bits 3-2 at `00` turn the R6551's
transmitter off as well and TDRE never sets.

With it off, the far end ignores RTS: everything is sent at the line rate, and a
byte that reaches the ACIA while its receiver is disabled — command register bit
0 clear, as after a reset — is lost, as it would be at the board.

### keypad

The pad, and on a machine without a Serial Card the only input there is. Where
6502-EMULATOR has `input.key`, `input.joystick` and `input.type`, there is
exactly this: the MM74C922 reports one thing, a code, and there is nothing else
on the board to drive.

| Method | Params | Returns |
|---|---|---|
| `keypad.press` | `key` — a name, an encoder code, or a list of either; `kps?` (default 10) | `keys` — each `{code, label}` |
| `keypad.map` | — | `keys` — the whole pad |

```jsonc
{"method": "keypad.press", "params": {"key": "ESC"}}
{"method": "keypad.press", "params": {"key": ["0","8","0","0"]}}
{"method": "keypad.press", "params": {"key": 10}}          // the same as "0"
```

**There is no `down` and no release.** The encoder reports the press and nothing
else — releases never reach the PIA on the real board — so offering one would
invent a signal the hardware does not send.

**The code is not the key's value.** `0` is `$0A`, `$00` is the left arrow, and
`C` to `F` run backwards, because the encoder numbers the switches in the order
they sit on the board. Pass names and let `KeypadMap` do it. Names are
case-insensitive, and the four glyph keys answer to words too: `LEFT`, `RIGHT`,
`UP` (also `ENTER`, `RUN`) alongside `◄`, `►`, `▲`.

**A sequence is paced, and a single press is not.** One key latches immediately
and works on a paused machine, which is where most of a debugging session is
spent. More than one needs the machine running, and they are delivered one per
execution chunk with at least `1/kps` of emulated time between them. That is not
politeness: the encoder latches a single code and the CA1 interrupt handler's
read is what clears it, so two presses with no emulated time between them means
the second overwrites the first before the firmware saw it, and the keystroke is
simply gone. Keying into a paused machine is refused rather than hanging.

`keypad.map` returns `code`, `label`, `glyph`, `value?`, `row` and `col` for all
24 keys. The eight without a `value` are the command keys — `ESC INS PGUP ▲ DEL
PGDN ◄ ►` — which is also what the panel colours by.

### lcd

The 16×2 on the Keypad LCD Helper. Where 6502-EMULATOR reads a video card, this
reads the machine's own display — the one the KC Monitor draws its address and
byte on. It is never `NOT_SUPPORTED`: the video card is optional, the Keypad Card
is soldered in.

| Method | Params | Returns |
|---|---|---|
| `lcd.text` | — | `lines` — two strings of 16 characters |
| `lcd.hash` | — | `hash` — a cheap panel digest |
| `lcd.pixels` | — | `width`, `height`, `cols`, `rows`, `data` (base64) |

`lcd.text` reads DDRAM through the controller's own scroll and row mapping, so
what comes back is what a person looking at the glass would read — a shifted
display reports what is showing, not what is stored.

`lcd.hash` is CRC-32 over the *pixels* rather than the text, because the cursor,
the blink phase and a CGRAM redefinition are all things the panel shows and DDRAM
alone does not. Enough for "did the panel change", and not a security claim.

`lcd.pixels` is the buffer the panel is drawn from, one byte per dot: `-1` (which
arrives as `255`) is the gap between characters, `0` an unlit dot and `1` a lit
one. The unlit dots matter — on this display they are visible, and a renderer
that drew only the lit ones would not look like an LCD at all.

**There is no `lcd.png`.** Sixteen by two characters reads perfectly well as text,
and the pixel buffer is available whole for anything finer, so the PNG encoder
`screen.png` needed does not come across.

### state

Whole-machine snapshots.

| Method | Params | Returns |
|---|---|---|
| `state.save` | — | `state` (the snapshot), `version`, `bytes` |
| `state.load` | `state` or `path`, `force?` | `version`, `romMismatch?`, `cardROMMismatch?` + run state |

The snapshot is plain JSON, around 50 KB. No host here can write files, so
`state.save` hands the snapshot back and saving it is the caller's business —
which is also what you want, because the emulator may be a packaged app in
another directory.

This is the biggest single lever available to a test loop on this machine, more
so than on the ACE: booting to the monitor costs the BIOS countdown *and* the
LCD's ~1.8 M-cycle power-on ritual, and there is no honest way to skip the latter
because the four ~41 ms delays are what the firmware does. Boot once, save at the
monitor, restore per test case.

A snapshot is checked before it is applied and refused rather than half-applied:
wrong `format`, a `version` this build does not read, a different slot layout, or
either ROM's checksum not matching. `force` overrides only the ROM checks.

Both ROMs are stored by identity — length and CRC-32 — rather than content, since
the host loads them anyway. That includes the Keypad Card's, which is where the
ACE stores its cartridge image in full; a cartridge can be swapped on a running
machine and its bytes may not be findable again, and nothing here can be. It also
makes this the check that fires most often in practice, because the KC Monitor is
developed in the sibling repository and "restore yesterday's session onto today's
firmware" is the ordinary Tuesday mistake.

The Keypad Card's PIA is stored as one field, `pia`, with the keypad's latch and
the LCD's controller state nested inside it — the honest encoding of a card where
the 65C21 is the only thing on the bus. A snapshot taken between a key press and
the interrupt handler's read is holding a keystroke, and it comes back holding it.

Two things are deliberately absent: the LCD's pixel buffer, which `updatePixels()`
rebuilds from DDRAM and the flags, and the cycle counters, which the host uses to
measure elapsed time and nothing emulated reads.

### wait

| Method | Params | Returns |
|---|---|---|
| `wait.for` | at least one of `serial`, `stopped`, `cycles`, `expression`; plus `since?`, `run?`, `timeoutMs?` (default 10000) | `matched`, `reason`, `cycles`, `elapsedCycles`, `elapsedMs`, `output?`, `stop?` + run state |

One blocking call instead of a poll loop with sleeps tuned by guesswork — which is
the flakiness that makes an agent distrust a tool.

- `serial` — a regex over console output, from `since` (default: the last write's
  cursor). Needs a Serial Card.
- `stopped` — a breakpoint, watchpoint or pause. **A machine that has already
  stopped satisfies this**, which for a one-shot caller is the normal case rather
  than an edge one: the breakpoint armed by one command has usually fired before
  the next command connects. Combined with `run`, it means "continue, and tell me
  when it stops again".
- `cycles` — emulated cycles from now.
- `expression` — the same language breakpoint conditions use.
- `run` — resume in this mode first, for waiting on a paused machine.

A timeout is reported as `matched: false`, not as an error.

There is no `wait.for {lcd}`. Waiting on the panel is `run` plus `cycles` and then
`lcd.text` — the LCD is repainted by the monitor's own loop rather than pushed at
the host, so there is no event to hang a condition on.

---

## Notifications

Server to client, over WebSocket only.

| Notification | Params | When |
|---|---|---|
| `attached` | `protocol`, `host`, `version` | On connect |
| `stopped` | `stop` | The machine stopped advancing |
| `resumed` | `mode` | It started again |
| `serial.data` | `data` | The console produced output (coalesced per turn) |
| `log` | `message` | A connection-level problem |

`stopped` and `resumed` fire for transitions this client did not cause — another
client resuming the session, or a breakpoint firing — so a UI can track state
without polling. They arrive in the true order: a breakpoint that fires inside the
slice `exec.run` starts synchronously is reported *after* the `resumed` that
preceded it.

## Errors

Standard JSON-RPC codes, plus four of our own in the reserved application range.

| Code | Name | Meaning |
|---|---|---|
| `-32700` | Parse error | Not JSON |
| `-32600` | Invalid request | Not a JSON-RPC 2.0 request |
| `-32601` | Method not found | No such method |
| `-32602` | Invalid params | A bad or missing parameter — including an unresolvable symbol, or a key that is not on the pad |
| `-32603` | Internal error | A fault in the emulator |
| `-32000` | Not supported | The method exists but this host cannot serve it — no Serial Card, no filesystem |
| `-32001` | Load failed | A ROM, binary, symbol file or snapshot could not be loaded |
| `-32002` | Unauthorized | Token missing or wrong |
| `-32003` | Invalid state | The machine's current state does not allow it |

`-32000` is worth designing for: capabilities genuinely differ between hosts and
between machines. A KIM with io5 vacant has no serial console at all, and the
desktop app's renderer has no filesystem of its own. The protocol says so rather
than pretending.

### CLI exit codes

`6502-kim dbg` and `6502-kim attach` map all of the above onto codes a script can
branch on without scraping text:

| Code | Meaning |
|---|---|
| `0` | Ok |
| `1` | Usage error, or an RPC error |
| `2` | A `wait` or `send --wait` timed out |
| `3` | No emulator found — no lock file, or the socket refused |
| `4` | `step`/`runto`/`runcycles` stopped on a breakpoint or watchpoint |

---

## Differences from 6502-EMULATOR

For anyone porting a script across. Everything not listed is identical.

**Gone**, because the hardware is not there:

| Removed | Why |
|---|---|
| `media.loadCart`, `media.unloadCart` | There is no cartridge slot. The Keypad Card is soldered in; `media.loadCardROM` changes its firmware. |
| `media.loadProgram` | No BASIC, so no end-of-program pointers to fix up. `media.loadBinary` is the whole story. |
| `input.key`, `input.type` | No matrix keyboard. `keypad.press` takes its place. |
| `input.joystick` | No joysticks. |
| `screen.text`, `screen.hash`, `screen.png` | No video card. `lcd.text` and `lcd.hash` take the first two; the third has nothing worth encoding. |
| `mem.*` spaces `vram`, `nvram`, `cf` | No video card, no RTC, no storage. |

**New**, or changed:

| Method / field | Change |
|---|---|
| `keypad.press`, `keypad.map` | The pad. Paced sequences, no releases, encoder codes via `KeypadMap`. |
| `lcd.text`, `lcd.hash`, `lcd.pixels` | The 16×2 panel. Never `NOT_SUPPORTED`. |
| `media.loadCardROM` | The Keypad Card's 8 KB image. |
| `mem.*` space `card` | The same image, byte-addressable and writable. |
| `sym.load` format `lst` | ca65 listings, which is what the KC Monitor's build produces. |
| `session.info` `serialCard` | Replaces `cartridge`. |
| `session.info` `flowControl` | The same field as 6502-EMULATOR's, and it does the same work: the KC Monitor raises RTS once its receive ring passes `$C0` unread bytes, so input really is held. |
| `session.info` `console` | `serial` or **`keypad`**, not `serial` or `video`. |
| `state.load` `cardROMMismatch` | The second ROM's `force` report. |
| Snapshot `format` | `6502-kim-snapshot`. The two are not interchangeable, and each refuses the other's. |
| Snapshot `pia` | Replaces nothing — the Keypad Card is not in a slot, so it sits beside `cpu` and `ram`. |
| Lock file | `~/.6502-kim/session.json`, `$SIXTY5O2_KIM_HOME`. |
