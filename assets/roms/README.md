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
  **`v1.7`**, cut on branch `v1.x`, not the repository's `main`, which is BIOS
  2.x
- **Commit** — `387d29d5396b821568e7b9a41fa7e7fccf6d1b76` (2026-11-11)
- **Version string** — `6502 BIOS v1.7`
- **SHA-256** — `49be5865bde74220f37ad10bd773619b17f052b37c89f79c1a3564b7da51d799`

**1.7 is two probes the KIM itself found wrong** (6502-WORKING's BIOS plan, B1 and
B4, measured on a real KIM on 3 and 11 November 2026), and both are visible here
now that this machine reads an empty slot as open bus, as the board does:

- **The SID probe no longer finds a SID in an empty slot.** 1.6 read voice 3
  once and took anything but `$00` or `$FF`; an empty slot reads `$98`, so a KIM
  with no Sound Card booted with `HW_PRESENT` `$50` and ran the SID setup into an
  empty window. 1.7 wants voice 3's noise to change between reads. A KIM without
  a Sound Card now reads `$10`.
- **The CF probe recognises an empty slot and skips the wait**, which 1.6 spent
  0.85 s on at every boot of a KIM without a Storage Card. An empty slot reads
  `$8C` at `$8C07` and `$8F` at `$8F07`; a card answers one status at both. With
  a card it waits up to 3.0 s and leaves how long it took for a `PEEK`:
  `CF_PROBE_POLLS` at `$0376–$0377` (polls of 0.1 ms) and `CF_PROBE_STAT` at
  `$0378`, the first status byte.

Every 1.6 routine address holds. Earlier images this repository bundled, newest
first: 1.6 at `8acb4fc` (sha256 `4b4154af…`), the last of 1.6's in-place reissues
(`f858890`, `29ed506f…`; `27bd4e0`, `4ec29214…`; `71e1e66`, `fc0002d0…`, 1.6 as
first released), whose serial flow control is what this ROM still carries: RTS
lowered around each byte sent, the input ring never lapping its reader, the IRQ
handler reading the data register only when `RDRF` says a byte is there, and the
console quiet above the high-water mark. None of that is reachable from a KIM's
own console — the KC Monitor is what runs there, and it carries its own copy of
the same scheme (see below).

Its NVRAM save slots need an RTC card, which a KIM doesn't have, so every `Nv*`
entry returns carry set.

**The KIM stays on BIOS 1.x.** Future updates come only from 6502-BIOS `v1.x`.
`BundledROM.test.ts` refuses any other version string.

## KCMonitor.bin — 8 KB

The Keypad Card's own ROM: an AT28C64 at `$E000–$FFF9`, carrying the KC Monitor
and the CPU vectors at `$FFFA–$FFFF`. This is what the machine boots into, and
it is the reason a KIM is a KIM rather than an ACE with no video card.

Renamed on the way in — upstream it is `KC Monitor.bin`, with a space, which is
awkward in a URL the web build has to fetch.

- **Source** — `/Users/acwright/Developer/Kicad/6502-KIM`,
  `Firmware/KC Monitor/KC Monitor.bin`
- **Commit** — `b01b5dcda9409385188abab4ec47bed237dac3c0` (2026-11-11)
- **Version string** — `KIM MONITOR v1.1`
- **SHA-256** — `4defbbea6dca97fde50c69a5bdd9c584c946b0010003fc2aaa66ba78a1d015a0`

The first image whose version string moved. Earlier images this repository
bundled, newest first, all `v1.0`: `53cb4e1` (sha256 `19c7ed60…`), which brought
the RTS scheme below; `3b5aa80` (sha256 `06601fb6…`), which made serial `R` a
call; before it, the build that put the splash gate on both consoles.

### Serial `R` lets the monitor's last byte out first (v1.1)

`R` now waits, for a bounded time, for the ACIA to take the monitor's last byte
before it calls the program. The monitor's `SerPutc` waits for TDRE and then
writes, so that byte could still be in the transmit register when the program
started, and the BIOS's `Chrout`, which writes first and waits afterwards,
overwrote it: *Hello, KIM* printed `0800: AHELLO` on a real KIM where this
emulator showed `0800: ADHELLO`. This emulator's ACIA does not model a byte
waiting in that register, so it never showed the bug and shows no change; the
machine now agrees with it. The wait is `SerPutc`'s own, so a KIM with no
terminal still runs the program.

### The serial console holds the far end off with RTS

New in `53cb4e1`, and the reason the digest moved then. A 20-line Wozmon deposit
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
