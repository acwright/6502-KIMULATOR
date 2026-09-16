# VDP assessment: 6502-KIMULATOR

> An outline, not a plan. The work here is small enough to do from this file. Surveyed
> 2026-09-16 across the whole workspace.

## The change

The ACE moves from a Pico9918 running stock TMS9918A firmware to the **6502-PICOVDP**
(`6502-PICOVDP/SPEC.md`) on PICO9918 PRO v2.0 hardware, running **BIOS 2.x**. Everything
else stays where it is: COB, DEV, KIM, VCS, PicoCalc, and any ACE whose card cannot be
reflashed (RP2040 pico9918 v1.0–1.3). Those keep the stock firmware and **BIOS 1.x**,
whose last release is **1.6**.

- **Legacy** in these documents means TMS9918A + BIOS 1.x. **VDP** means PICOVDP + BIOS 2.x.
- **Compatibility runs one way.** The PICOVDP's legacy submode runs Text and Graphics I
  programs unchanged, so BIOS 1.x and existing cartridges run on it. Graphics II and
  Multicolor fall back to Graphics I and draw garbage. Register writes above 7 no longer
  alias, so F18A tricks break. Sprites per line are 16 by default, not 4. Nothing written
  for the VDP runs on a TMS9918A.

## Decisions already made

- **No new repositories.**
- **BIOS 1.6 is the last 1.x release.** It is 1.5 plus the NVRAM save slots in
  `6502-BIOS/PLAN.md`, and nothing else. It ships in emulator **2.7.0**, and the frozen
  legacy docs document it.
- **BIOS 2.0 is 1.6 plus:**
  - The PICOVDP work in `6502-EMULATOR`'s `docs/handoff/6502-BIOS.md` (branch `v3-vdp`):
    card detection, hardware scroll, port B for interrupt handlers, `WaitVBlank`.
  - A console in the PICOVDP's **Text mode** (`VMODE $1`, 40×24, 6×8 cells) with a
    **per-cell colour table**. It keeps the same font and every screen layout.
  - **No Monitor.** The machine **boots straight to BASIC**, with a new header and a colour
    logo drawn from the font's CP437 block characters. Wozmon stays at `$FF00`.
  - **The font lives in the PICOVDP firmware.** The card loads it into VRAM at reset and
    on command (a new register and a capability bit, SPEC draft 0.5). ROM `$B800` holds
    no font on 2.x.
  - **ROM layout:** BASIC takes the Monitor's 4.3 KB (`$C000–$FEFF`), and the Kernal takes
    all of `$A000–$BFFF`, including the space the font used. Nothing the Kernal needs goes
    above `$C000`, because cartridges overlay `$C000–$FFFF`. The Kernal holds the
    primitives cartridges need; BASIC-only work lives in BASIC.
  - **No TMS9918A support.** BIOS 2.x runs only with a PICOVDP, with no fallback paths.
  - **New BASIC commands with matching Kernal entries.**
    - Core: `SCREEN`, `VPOKE`/`VPEEK`, `VREG`, `PALETTE`, `VSYNC`, `VLOAD`.
    - Second tier, if room is found: `SPRITE`, `SCROLL`, `LAYER`, `VSTAT`.
    - Save-slot commands, if room is found.
    - `SYS addr[,a,x,y]`, and `BLOAD`/`BSAVE` over XModem when given no filename.
    - BASIC returns to the text console when a program stops.
  - **Tokens:** every 1.x token keeps its value, and new keywords are appended after `$D4`.
    The `BRK` statement is retired and its token `$B4` goes to a new keyword.
  - **A BRK instruction** prints `BREAK $nn AT $xxxx  A= X= Y= P= S=` and warm-starts
    BASIC. `BRK_PTR` stays hookable.
  - **`COLOR fg[,bg[,border]]`** sets the pen for later output, `CLS` fills the screen with
    it, and `border` is register 7's low nibble.
  - **Existing jump-table addresses do not move.** New entries are appended.
- **6502-EMULATOR** makes the video card an option (TMS9918A or PICOVDP): one app, one
  site. It also publishes a frozen **2.7.0** web build at `/6502-EMULATOR/v2/` for the
  legacy docs.
- **6502-DOCS** is versioned: legacy docs (BIOS 1.6) are frozen at `/6502-DOCS/v1/`, and
  the main site is rewritten for the VDP and BIOS 2.x.
- **6502-BIOS** gets a `v1.x` branch cut at `v1.6`; `main` becomes 2.x.
- **Assembly and C projects** get a VDP include chosen by a build option, not branches.
  The legacy `6502.inc` gets one last update, for 1.6.
- **EhBASIC and vc83basic** stay 1.x. **PicoCalc** and **KIMULATOR** stay legacy and ship BIOS 1.6. **The YouTube series**
  teaches the legacy VDP and mentions the new features.

## Order across the workspace

**Part 1: BIOS 1.6, the last legacy release**

1. **6502-BIOS:** build 1.6 on `main`, tag `v1.6`, and cut `v1.x` from it.
2. **6502-EMULATOR `main`:** bundle 1.6, release **2.7.0**, and publish its frozen web build
   at `/6502-EMULATOR/v2/`. Then merge `main` into `v3-vdp` and re-capture the goldens
   there; they exist only on that branch.
3. **6502-PICOVDP:** re-sync `tests/oracle/`, whose pinned `bios` goldens moved.
4. **The legacy include** gains the NVRAM entries in every copy: 6502-ASM, 6502-CRT,
   6502-PRG, 6502-BIN, 6502-EHBASIC, 6502-C (with `6502.h`) and WIZARDSLAB.
5. **6502-DOCS `main`** documents 1.6 and pins 2.7.0. Then it cuts `v1`, published at
   `/6502-DOCS/v1/`, against the emulator's frozen 2.7.0 build at `/6502-EMULATOR/v2/`.

Alongside steps 2–5, once step 1 is tagged: **6502-PICOCALC** embeds the `v1.6` ROM and
releases a new UF2, and **6502-KIMULATOR** bundles it and releases 1.0.9. DOCS waits for both
releases before cutting `v1`.

**Part 2: the VDP**

6. **6502-PICOVDP:**
   - SPEC draft 0.5 adds the built-in font and its load command. The emulator's PICOVDP
     card implements it first, then the firmware.
   - Firmware proven on the PRO (its Phases 9–11) gates the hardware switch, not the
     software work.
7. **6502-EMULATOR:** `v3-vdp` merged, with the card as an option; tagged 3.x.
8. **6502-BIOS:** 2.0 on `main`. This can start once step 1 is done, because the `v3-vdp`
   emulator already runs the PICOVDP. Its console work needs the built-in font in the
   emulator (step 6).
9. **6502-ASM** sets the VDP include convention. 6502-CRT, 6502-PRG, 6502-BIN and 6502-C
   follow it.
10. **Everything else follows BIOS 2.0:**
    - The emulator bundles BIOS 2.0.
    - 6502-DOCS `main` is rewritten.
    - bastok gains the 2.x token table.
    - 6502-ACE, WIZARDSLAB, 6502-EHBASIC, vc83basic, cffs and 6502-ASSEMBLY follow.

---

## This repository's role

The KIM's emulator: desktop app, web app and `6502-kim` CLI. It bundles two ROMs: the family's
`BIOS.bin`, of which a KIM sees only the Kernal and character set at `$A000–$BFFF`, and the
Keypad Card's `KCMonitor.bin`, which overlays `$C000–$FFFF`. **The KIM is a legacy machine
forever:** no video card, no RTC, no storage. Nothing in Part 2 applies to it. Part 1 applies
because it ships the family's BIOS.

## Where it stands

- Released as `v1.0.8`. Releases are a "Release v1.0.x" commit whose body is the release
  notes, then a tag. The web build deploys from `main` to `/6502-KIMULATOR/`.
- The BIOS is bundled twice (`assets/roms/BIOS.bin`, `src/renderer/public/roms/BIOS.bin`).
  `assets/roms/README.md` records its source commit, version string and SHA-256.
  `src/tests/BundledROM.test.ts` pins the digest (`ecd753a2…`, 6502-BIOS `d1fcefe`, v1.5).
- `src/core/CPU.ts` and its tests are byte-identical with 6502-EMULATOR's. Unaffected here.
- 6502-DOCS pins it in `data/kimulator.json` (`"version": "1.0.8"`); `check-links.mjs`
  verifies the embed contract.

## Verified before planning (2026-09-16)

BIOS `v1.6` was run under KIMULATOR 1.0.8 (`6502-kim run --rom`) against all twelve KIM
series check scripts in 6502-ASSEMBLY (`Assets/Tools/verify/run-all.sh`), compared with the
bundled 1.5:

- **Identical results except episode 14's version line**, which prints `BIOS v1.6` and reads
  minor version 6, as it should. Every cycle-exact claim holds: episode 14's `SysDelay`
  measurement and episode 16's 500,000-cycle beat.
- Every Kernal routine up to `RtcWriteNVRAMImpl` keeps its address in 1.6. 52 routines after it
  moved, including `Irq`, `Nmi`, `Break` and `ProbeRTC`, but none of those moves shows in any
  check.
- On a KIM the save slots are unreachable: there is no RTC, so every `Nv*` entry returns carry
  set.
- **Pre-existing and unrelated:** episode 15's check already fails on 1.5, expecting the KC
  Monitor's IRQ entry at `$E49C` where the bundled KC Monitor has it at `$E4A2`. That is drift
  from the KC Monitor update in 1.0.8, not from the BIOS (see 6502-ASSEMBLY's assessment).

## Work outline

**`VDP-PLAN.md` has the detailed steps**, written for a session working this repo and
6502-EMULATOR together. It also tightens `BundledROM.test.ts` to refuse a 2.x BIOS, because
**the KIM never moves to BIOS 2.x**.

**Part 1, after 6502-BIOS tags `v1.6` (done: commit `71e1e66`):**

1. **Bundle the ROM.** Copy `git -C ~/Developer/Assembly/6502-BIOS show v1.6:BIOS.bin` into both
   paths. Confirm they're byte-identical and that SHA-256 is
   `fc0002d0ae25240ed36cfa4bea12735ee71fb05017651bf726520af0658be0a0`.
2. **Pins.**
   - `src/tests/BundledROM.test.ts`: the new digest and its source-commit comment.
   - `assets/roms/README.md`: commit, date, version string `6502 BIOS v1.6`, SHA-256.
3. **Test.** `npm test`, since the suites boot the real bundled BIOS and KC Monitor, and
   `npm run typecheck`. `test:conformance` is untouched by a ROM change.
4. **Release `v1.0.9`.** In the release notes:
   - it carries BIOS 1.6, the last 1.x release
   - the only change a KIM can see is `KernalVersion` reporting 1.6
   - the save slots need an RTC, which a KIM doesn't have
5. **Hand off.**
   - **6502-DOCS:** pin `1.0.9` in `data/kimulator.json` during its Part 1 step A, and wait
     for this release before cutting `v1`.
   - **6502-ASSEMBLY:** episode 14's check script and episode note (its assessment).
   - **6502-ASM:** the BIOS version in the KIM includes' headers (its assessment, step 0).

**Part 2:** none.

## Linked repositories

| Repository | Path | Why |
|---|---|---|
| 6502-BIOS | `~/Developer/Assembly/6502-BIOS` | The `v1.6` `BIOS.bin` to bundle |
| 6502-DOCS | `~/Developer/NodeJS/6502-DOCS` | Pins KIMULATOR in `data/kimulator.json`; its `v1` docs embed the live KIMULATOR |
| 6502-ASSEMBLY | `~/Developer/YouTube/6502-ASSEMBLY` | The KIM series runs on KIMULATOR; episode 14 prints the BIOS version |
| 6502-ASM, 6502-KIM | `~/Developer/Assembly/6502-ASM`, `~/Developer/Kicad/6502-KIM` | KIM includes whose headers name the BIOS version |
| 6502-EMULATOR | `~/Developer/NodeJS/6502-EMULATOR` | Shares `CPU.ts`; releases 2.7.0 with the same ROM |
