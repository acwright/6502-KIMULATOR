# Bundled ROMs

Two images, both build artifacts of other repositories. **They are never edited
here.** When either changes upstream, re-copy it, update the table below, and
re-run the tests.

Each ships twice, because two builds load it from two places:

| Path | Loaded by |
|---|---|
| `assets/roms/` | Electron and the CLI, via `extraResources` |
| `src/renderer/public/roms/` | the web build, fetched from `BASE_URL + roms/…` |

The copies must stay byte-identical; `BundledROM.test.ts` (phase 1) is what
holds them to it. Updating one and not the other ships a desktop app running a
different ROM from the browser build, and every test would go on passing.

## BIOS.bin — 32 KB

The family's BIOS. Spans `$8000–$FFFF` as an image, but only `$A000–$BFFF` of it
is visible on a KIM: the Kernal at `$A000–$B7FF` and the CP437 character set at
`$B800–$BFFF`. The Keypad Card overlays everything above.

- **Source** — `/Users/acwright/Developer/Assembly/6502-BIOS`, `BIOS.bin` at tag
  **`v1.6`**, cut on branch `v1.x`, not the repository's `main`, which is BIOS
  2.x
- **Commit** — `8acb4fc1d410f523a0ba64308ac1c1d9e22098a2` (2026-09-17)
- **Version string** — `6502 BIOS v1.6`
- **SHA-256** — `4b4154afac681e26324d3f5a845e41770d977c05db1ef6516c9d2c5e210d8c56`

**`v1.6` is reissued in place**, always as 1.6 and always with the same banner,
so the digest above is the only thing that tells one 1.6 from another. Earlier
images this repository bundled, newest first: `f858890` (sha256 `29ed506f…`),
which lowered RTS around each byte sent; `27bd4e0` (sha256 `4ec29214…`), which
lowered RTS as BASIC read the buffer but still deadlocked a real R6551; and
`71e1e66` (sha256 `fc0002d0…`), 1.6 as first released. The tag as it now stands
adds the rest of what the bench found: the input ring no longer laps its reader
at 256 unread bytes, the IRQ handler reads the data register only when `RDRF`
says a byte is there, and the console goes quiet above the high-water mark
rather than reopening the gate for an echo. Pastes to 14 KB arrive byte-perfect
on hardware with flow control on.

None of that is reachable from a KIM's own console — the KC Monitor is what runs
there, and it carries its own copy of the same scheme (see below) — but it is
the ROM the Serial Card's BIOS path runs, and the digest has to match what the
tag holds.

On a KIM, 1.6 changes only what `KernalVersion` reports. Its NVRAM save slots
need an RTC card, which a KIM doesn't have, so every `Nv*` entry returns carry
set.

**The KIM stays on BIOS 1.x.** Future updates come only from 6502-BIOS `v1.x`,
as 1.6.x. `BundledROM.test.ts` refuses any other version string.

## KCMonitor.bin — 8 KB

The Keypad Card's own ROM: an AT28C64 at `$E000–$FFF9`, carrying the KC Monitor
and the CPU vectors at `$FFFA–$FFFF`. This is what the machine boots into, and
it is the reason a KIM is a KIM rather than an ACE with no video card.

Renamed on the way in — upstream it is `KC Monitor.bin`, with a space, which is
awkward in a URL the web build has to fetch.

- **Source** — `/Users/acwright/Developer/Kicad/6502-KIM`,
  `Firmware/KC Monitor/KC Monitor.bin`
- **Commit** — `53cb4e15b403e3e6ebab13dae4afc66ac483291f` (2026-09-17)
- **Version string** — `KIM MONITOR v1.0`
- **SHA-256** — `19c7ed60cd66f7e96c95581e603a5817fb8e75d386ebb3346c7b6478713d26f4`

The version string does not move with the image. Earlier images this repository
bundled, newest first: `3b5aa80` (sha256 `06601fb6…`), which made serial `R` a
call; before it, the build that put the splash gate on both consoles.

### The serial console holds the far end off with RTS

New in this image, and the reason the digest moved. A 20-line Wozmon deposit
paste at 19,200 baud used to lose nine lines — at 9600 all twenty arrived — and
the transcripts with flow control on and off were byte-identical, because
nothing wrote the ACIA's command register after `InitSC`'s `$09`.

The monitor now runs the same scheme the Kernal does, for the same reasons the
bench found on a real R6551:

- **RTS up at `$C0` unread bytes, down below `$80`**, in the monitor's own
  256-byte receive ring. With flow control on (the default here) a paste of any
  length arrives whole; the ring is held at exactly `$C0` and input waits.
- **RTS comes down around each byte sent**, because TIC `00` turns the
  transmitter off as well as raising the pin. The monitor's `SerPutc` does not
  block like the BIOS `Chrout` — it waits a bounded time for TDRE and drops the
  byte — so with RTS standing it went mute rather than hanging. Either way the
  terminal heard nothing.
- **Above the high mark it goes quiet instead of sending**, because every send
  reopens the gate and an echo would keep a flooded ring flooded. A long paste
  is therefore echoed only in part. The deposits all land; read them back.
- **A full ring drops the incoming byte** rather than lapping its own reader.
- **The LCD is repainted once per batch**, not once per deposit line. A full
  `RefreshDisplay` is ~22 ms of panel time, more than a line of paste takes to
  arrive at 19,200 baud, which is what the monitor was losing the race to.

One visible consequence for anything driving `$9002` from the console: the
monitor owns that register now. A deposit to it holds only until the next
character goes out. The old behaviour — `9002: 01` leaving the board mute for
good — is gone, and the test that pinned it drives the chip directly instead.

### Serial `R` is a call in this build

`XXXX R` is a `JSR` through `XAML`, not original Wozmon's `JMP (XAML)`. A
program that ends in `RTS` now returns to the parser and gets a fresh `> `
prompt, matching the pad's `▲`, which has always run the program under the
cursor as a subroutine.

Before this build an `RTS` left the terminal with no prompt *and* a line buffer
still holding the `XXXX R` that launched it, so the next line typed was appended
to that line and re-ran the program rather than being parsed. Anything that
drove the serial monitor and worked around that — expecting a run to time out,
or ending every program in `STP` — still works; `STP` still halts the machine.

### The splash gate changed in the previous build

Worth knowing, because it is the first thing anything driving this machine
runs into. Both consoles now show `--ESC TO START--` and both mean it:

- **`ESC` is the only key that starts the monitor.** The pad used to open the
  gate on any key. It no longer does — `RIGHT` leaves you on the splash.
- **The serial `> ` prompt appears only after the gate opens.** It used to go
  out ahead of it, in front of a parser that was not running yet, so anything
  typed at it either vanished or executed later depending on how the splash
  was dismissed. Waiting on `>` to decide the machine is ready now deadlocks
  if the `ESC` that opens the gate is what you were holding back — wait on
  `ESC TO START` instead.
- **One `ESC` starts both consoles**, from either source, and the gate
  discards everything typed or pressed at the splash on the way through.
