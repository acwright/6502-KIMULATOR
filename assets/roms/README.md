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

- **Source** — `/Users/acwright/Developer/Assembly/6502-BIOS`, `BIOS.bin`
- **Commit** — `d1fcefe0725aac033126a529e135675b1624f6c8` (2026-08-05)
- **Version string** — `6502 BIOS v1.5`
- **SHA-256** — `ecd753a22d9ac5e91653d0f4c20ddd5df38637f2a95a6e11b89f3e1ab71203ca`

## KCMonitor.bin — 8 KB

The Keypad Card's own ROM: an AT28C64 at `$E000–$FFF9`, carrying the KC Monitor
and the CPU vectors at `$FFFA–$FFFF`. This is what the machine boots into, and
it is the reason a KIM is a KIM rather than an ACE with no video card.

Renamed on the way in — upstream it is `KC Monitor.bin`, with a space, which is
awkward in a URL the web build has to fetch.

- **Source** — `/Users/acwright/Developer/Kicad/6502-KIM`,
  `Firmware/KC Monitor/KC Monitor.bin`
- **Commit** — `d88eb9a1d341561a5876e5c580bf833303c90146` (2026-08-04)
- **Version string** — `KIM MONITOR v1.0`
- **SHA-256** — `a2ee97d8e6f93b7d00842f94496c5ad2bacb33758bf03b8ece2a3c9cbe4b427d`
