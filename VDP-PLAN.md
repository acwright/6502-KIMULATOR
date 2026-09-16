# VDP plan: 6502-KIMULATOR

> **The whole of this repository's part in the VDP rollout: bundle BIOS 1.6 and release 1.0.9.**
> There is no Part 2. **The KIM never moves to BIOS 2.x**: it has no video card, and it stays on
> the 1.x line for good. The decisions and the cross-repo order are in
> [VDP-ASSESSMENT.md](VDP-ASSESSMENT.md).
>
> **Written for a session working both emulators at once.** The companion plan is
> 6502-EMULATOR's `VDP-PLAN.md` (committed on its `v3-vdp` branch; read it with
> `git -C ~/Developer/NodeJS/6502-EMULATOR show v3-vdp:VDP-PLAN.md`). §4 says how the two
> interleave.
>
> Written 2026-09-16 from `main` at `66cbf23` (v1.0.8). Line numbers drift; file names are the
> durable references.

---

## 1. Goal

1.0.9 is 1.0.8 plus 6502-BIOS `v1.6`'s `BIOS.bin`, and nothing else.

### Definition of done

- `main` bundles 6502-BIOS `v1.6` in both places. `BundledROM.test.ts` and
  `assets/roms/README.md` record it, and point at the 1.x line rather than 6502-BIOS `main`.
- A 2.x BIOS can't be bundled by accident: the version guard in `BundledROM.test.ts` accepts
  only `6502 BIOS v1.x` (§5).
- `npm run typecheck`, `npm test` and `bash examples/run-all.sh` pass.
- Tag `v1.0.9` is pushed. GitHub release `v1.0.9` has the four desktop artifacts, and the web
  build at `https://acwright.github.io/6502-KIMULATOR/` runs 1.6.
- The installed desktop app is 1.0.9, and the KIM series checks in 6502-ASSEMBLY give the
  expected result on it (§7).
- 6502-DOCS, 6502-ASSEMBLY and 6502-ASM have been told (§8).

---

## 2. Facts that shape this plan

All checked on 2026-09-16, not assumed.

- **What a KIM can see of the BIOS:** only `$A000–$BFFF`, the Kernal and character set. The
  Keypad Card's `KCMonitor.bin` overlays `$C000–$FFFF`. A KIM has **no RTC**, so every one of
  1.6's six `Nv*` entries returns carry set. The `ProbeRTC` fix never finds a card. The only
  observable change is `KernalVersion` (`$A07B`) returning minor version 6.
- **The 1.6 ROM:** 6502-BIOS tag `v1.6` at commit `71e1e66560cf08635812b062a038c14381dd8f69`.
  `BIOS.bin` SHA-256 is `fc0002d0ae25240ed36cfa4bea12735ee71fb05017651bf726520af0658be0a0`,
  and it contains `6502 BIOS v1.6` once. `v1.x` is cut at the same commit.
- **What moved in 1.6** (both tags rebuilt with symbols and compared):
  - Every Kernal routine up to `RtcWriteNVRAMImpl` (`$A7B6`) keeps its address. That includes
    `ChroutDispatch` `$A101`, `KernalInitImpl` `$A32F`, `Reset` `$A442` and `SysDelayImpl` `$A60F`.
  - 52 routines after it moved: for example `ProbeRTC` `$A8F1`→`$AA2B`, `Irq` `$B18E`→`$B2D0`,
    `Nmi` and `Break`.
  - Every published jump-table slot is still a `JMP` at the same address. 15 of them, from
    `$A03C` on, jump to new targets, because the table exists so that callers never see that.
- **This repo's tests, run against 1.6** (an export of `main` with only the two ROM files
  replaced):
  - `npx jest`: **1,385 of 1,386 pass.** The one failure is
    `BundledROM.test.ts › matches the digest recorded in assets/roms/README.md`, the pin
    this plan updates.
  - `bash examples/run-all.sh`: **all five examples pass.**
  - Nothing in `src/tests/` hard-codes a Kernal-internal address or an exact boot cycle
    count. The KIM tests and docs use cycle budgets (3,000,000, 500,000) as ceilings, not
    measurements.
- **The KIM YouTube series, run against 1.6** (6502-ASSEMBLY
  `Assets/Tools/verify/run-all.sh`, installed 1.0.8 CLI with `--rom` pointed at `v1.6`,
  compared with the bundled 1.5):
  - **Identical results except episode 14's version line**: *Hello, KIM* prints
    `BIOS v1.6` and leaves 6 in X, where the script expects `05`.
  - Every cycle-exact claim holds, including episode 14's `SysDelay` figure and episode 16's
    500,000-cycle beat.
  - **Episode 15's script already fails on 1.0.8 with BIOS 1.5.** It expects the Keypad
    Card's IRQ entry at `$E49C`, where the bundled KC Monitor has it at `$E4A2`. That comes
    from the KC Monitor update in 1.0.8, not from the BIOS, and it is 6502-ASSEMBLY's to fix.
- **ROM pins:**
  - `src/tests/BundledROM.test.ts` pins `sha256` and a `version` regex
    `/6502 BIOS v\d+\.\d+/` for `BIOS.bin`. A comment names `6502-BIOS @ d1fcefe…`.
  - `assets/roms/README.md` records source path, commit, version string and SHA-256, and says
    the two files are updated together.
  - No other file names the BIOS version: `README.md`, `docs/` and `examples/` have none.
- **Snapshots are tied to the ROM.** `src/debug/Snapshot.ts` stores the ROM's CRC-32 and
  refuses a snapshot taken against a different BIOS ("taken against a different BIOS ROM …
  pass force to restore anyway"). Snapshots made on 1.0.8 need `--force` on 1.0.9, or re-taking.
- **Release mechanics** (from `v1.0.8`):
  - The release commit is `Release v1.0.x`, touching `package.json`/`package-lock.json`, with
    a summary body.
  - **The tag is annotated** (`git tag -a v1.0.x -m v1.0.x`), unlike 6502-EMULATOR's
    lightweight tags.
  - GitHub release `v1.0.x`, whose notes are a long-form write-up with `---` sections.
  - Artifacts come from `npm run dist` (`dist:mac` with notarization, `dist:win`,
    `dist:linux` via Docker): `6502-kimulator-1.0.x-mac-arm64.dmg`,
    `6502-kimulator-1.0.x-win-x64.exe`, `6502-kimulator-1.0.x-linux-x86_64.AppImage` and
    `6502-kimulator_1.0.x_amd64.deb`.
  - `ci.yml` runs on pushes to `main` and on PRs. `deploy.yml` runs on pushes to `main`, so the
    ROM bump is live on the web as soon as it's pushed.
- **The installed CLI** `/usr/local/bin/6502-kim` is a shim into
  `/Applications/6502 KIMulator.app`. 6502-ASSEMBLY's checks and 6502-DOCS's KIM tooling use
  it, so installing the 1.0.9 app is what hands 1.6 to them.
- **The CPU core is in sync with 6502-EMULATOR.** `CPU.ts`, `W65C02S.test.ts`,
  `Interrupts.test.ts`, `jest.conformance.cjs` and `fetch-conformance-tests.mjs` are identical
  in this repo's `main`, 6502-EMULATOR's `main` and its `v3-vdp`. Nothing in this work touches
  them.
- **Local state:** `main` is level with `origin/main`. The only untracked file is
  `VDP-ASSESSMENT.md`, committed with this plan.

---

## 3. Preconditions

1. ~~6502-BIOS tag `v1.6` exists and is pushed, and `v1.x` is cut from it.~~ **Done** (§2).
2. Take exactly one file from the tag: `BIOS.bin`. **Not** `KCMonitor.bin`: 6502-KIM may touch
   its `kim.inc` header for 1.6 (6502-ASM's step 0), but that is a comment, and the binary must
   not change. If 6502-KIM's `KC Monitor.bin` ever differs from the bundled one, that's a
   separate update with its own README section, not part of this release.
3. A clean tree on `main`, with this plan and the assessment committed first (§5.1).

---

## 4. Working both emulators at once

The two releases carry **the same ROM file** and can share one sitting. They differ in shape:

| | 6502-KIMULATOR | 6502-EMULATOR |
|---|---|---|
| Release | 1.0.9 | 2.7.0 |
| After release | done, forever on 1.x | frozen `/v2/` web build, merge `main` into `v3-vdp`, re-capture goldens, PICOVDP re-sync |
| Goldens | none | only on `v3-vdp` |
| Tag style | annotated | lightweight |
| BIOS version guard | tighten to `v1.x` (§5) | not now; 3.x bundles 2.x later |
| Web build | unversioned, stays unversioned | adds `/6502-EMULATOR/v2/` |

**Suggested order:**

1. **Bundle both** (this §5, and EMULATOR §4). Run each repo's tests. Commit and push each
   "Bundle BIOS v1.6" on its own `main`.
2. **Release KIMULATOR 1.0.9** (§6). It has no follow-on work, so finishing it first keeps
   one thread short.
3. **Release EMULATOR 2.7.0**, then its frozen `/v2/` deploy and the `v3-vdp` merge (EMULATOR
   §5–§7).
4. **Install both desktop apps**, then run the acceptance checks that use the installed CLIs:
   §7 here, and 6502-DOCS's preflight.
5. **Hand off** once (§8 here, EMULATOR §8), so 6502-DOCS gets both versions in one message.
   It pins both before cutting `v1`.

**Cross-checks while both are open:**

- **Same ROM.** Both repos' `assets/roms/BIOS.bin` must have SHA-256 `fc0002d0…658be0a0`.
- **CPU sync untouched.** The five shared files' hashes are identical across this repo's
  `main` and 6502-EMULATOR's `main` and `v3-vdp`, before and after. If either side changes
  one, stop: that is not part of this work.
- **One `6502-BIOS` checkout.** Both copy from `git show v1.6:BIOS.bin`, never from the
  working tree. 6502-BIOS `main` is heading to 2.x.

---

## 5. Bundle BIOS 1.6 on `main`

1. Commit this plan and `VDP-ASSESSMENT.md`: **"Add the VDP assessment and plan"**.
2. Copy the ROM into both paths:

   ```sh
   BIOS=~/Developer/Assembly/6502-BIOS
   git -C "$BIOS" show v1.6:BIOS.bin > assets/roms/BIOS.bin
   cp assets/roms/BIOS.bin src/renderer/public/roms/BIOS.bin
   ```

3. Check the image:

   ```sh
   cmp assets/roms/BIOS.bin src/renderer/public/roms/BIOS.bin
   shasum -a 256 assets/roms/BIOS.bin                  # fc0002d0…658be0a0
   grep -a -o '6502 BIOS v1\.6' assets/roms/BIOS.bin | wc -l   # 1
   git diff --stat -- assets/roms src/renderer/public/roms    # two binaries only
   ```

4. **`src/tests/BundledROM.test.ts`**:
   - `sha256` → `fc0002d0ae25240ed36cfa4bea12735ee71fb05017651bf726520af0658be0a0`.
   - The comment → `// 6502-BIOS @ v1.6 (71e1e66560cf08635812b062a038c14381dd8f69), the 1.x line`.
   - **Tighten the version guard** to `/6502 BIOS v1\.\d+/`, with a comment: the KIM stays on
     BIOS 1.x permanently, and a 2.x ROM must fail this test rather than ship. That is the
     executable form of the decision.
5. **`assets/roms/README.md`**, `BIOS.bin` section:
   - **Source** → `6502-BIOS`, tag `v1.6` (branch `v1.x`). **Not** the repo's `main`, which
     becomes BIOS 2.x.
   - **Commit** → `71e1e66560cf08635812b062a038c14381dd8f69` (2026-09-16).
   - **Version string** → `6502 BIOS v1.6`.
   - **SHA-256** → `fc0002d0ae25240ed36cfa4bea12735ee71fb05017651bf726520af0658be0a0`.
   - Add a short paragraph:
     - **What 1.6 changes on a KIM:** only `KernalVersion`. The save slots need an RTC, which
       a KIM doesn't have.
     - **The rule:** the KIM stays on BIOS 1.x. Future updates come only from 6502-BIOS
       `v1.x`, as 1.6.x.
6. Run `npm run typecheck`, `npm test` and `bash examples/run-all.sh`.
   - **Expected:** everything passes. §2 already measured 1,385/1,386 with only the digest
     failing, and that is fixed in step 4.
   - **If any other test fails,** it is new since 2026-09-16. Find out why before
     re-pinning anything.
   - `npm run test:conformance` is not needed: no CPU change.
7. Commit on its own: **"Bundle BIOS v1.6"**. In the body:
   - what 1.6 adds and that a KIM sees only the version change
   - the ROM's SHA-256 and the 6502-BIOS tag
   - that `BundledROM` now refuses a 2.x BIOS
8. Push `main`. CI must be green. The deploy puts 1.6 on the web build immediately, as ROM
   bumps have before.

---

## 6. Release 1.0.9

1. `npm version 1.0.9 --no-git-tag-version`. Only `package.json` and `package-lock.json`
   change.
2. Commit **"Release v1.0.9"**. The body:
   - The family's BIOS 1.6, its last 1.x release. On a KIM the only visible change is
     `KernalVersion` reporting 1.6: the NVRAM save slots need an RTC card, which a KIM
     doesn't have.
   - Every Kernal jump-table address is unchanged. Programs that call the table, as every KIM
     program should, run exactly as before.
   - **Snapshots taken on 1.0.8 are refused** (different BIOS ROM). Re-take them, or load with
     `6502-kim dbg state load --force`.
   - The KIM stays on BIOS 1.x permanently.
3. `git tag -a v1.0.9 -m v1.0.9`, then `git push origin main v1.0.9`.
4. `npm run dist` (mac needs the notarization credentials; linux needs Docker). Expect the four
   `6502-kimulator-1.0.9-…` artifacts listed in §2.
5. **Smoke-test the mac build:**
   - Launch it and get past `--ESC TO START--` into the KC Monitor.
   - On the serial console, deposit and run a `KernalVersion` + `Chrout` stub, or run
     6502-ASSEMBLY's *Hello, KIM*. It prints `BIOS v1.6`.
   - `6502-kim --version` from the app's CLI shim prints `1.0.9`.
6. `gh release create v1.0.9 --title v1.0.9 --notes-file <notes.md> dist/<the four files>`. The
   notes follow v1.0.8's long form:
   - a summary
   - `---` sections: what 1.6 is, what a KIM sees, the snapshot note, "the KIM stays on BIOS 1.x"
   - the downloads
   - that it's live on the web build
7. **Install the 1.0.9 app** in `/Applications`, so `/usr/local/bin/6502-kim` runs it.

---

## 7. Acceptance: the KIM series on the installed 1.0.9

From 6502-ASSEMBLY: `Assets/Tools/verify/run-all.sh 01-KIM`. Expected, and nothing else:

- **Episode 14 (*Hello, KIM*) fails its version assertions** (`expected 05, got 06`, and
  `version line not found`) until 6502-ASSEMBLY updates the script to expect whatever the ROM
  reports (its assessment). That's the one intended difference.
- **Episode 15 (*Interrupt Blink*) fails on `$E49C` vs `$E4A2`**, as it already did on 1.0.8.
- **Every other check passes,** including the cycle-exact ones in episodes 14 and 16.

Anything else failing means something changed between §2's measurement and the release. Stop
and compare against the installed 1.0.8 (`--rom` with the `v1.5` image).

---

## 8. Handoffs

### 6502-DOCS

- In its Part 1, step A4b: `data/kimulator.json` `"version"` → `"1.0.9"`.
- Read first, as its bump procedure asks:
  `git -C ~/Developer/NodeJS/6502-KIMULATOR diff v1.0.8 v1.0.9 -- docs/EMBEDDING.md assets/roms/`.
  The embed contract doesn't change in this release.
- Precondition P5 in its plan: it waits for this release before cutting `v1`.
- The frozen `v1` docs embed the live, unversioned `/6502-KIMULATOR/`. That is safe because the
  KIM stays on 1.x. **Any later KIMULATOR release that changes its embed contract must tell
  6502-DOCS**, because `v1` is frozen.

### 6502-ASSEMBLY

- Episode 14's check script: expect the version the bundled ROM reports.
- Episode 14's page or pinned comment: the live KIMULATOR prints `BIOS v1.6`.
- Episode 15's script: the `$E4A2` IRQ entry (unrelated to 1.6).
- All three are in its assessment. Send the §7 result with them.

### 6502-ASM (and 6502-KIM)

- The KIM includes' header comments become `BIOS v1.6` (6502-ASM's step 0). That covers
  `6502-ASM/6502-KIM.inc`, `6502-ASSEMBLY/01-KIM/Programs/kim.inc` and
  `6502-KIM/Firmware/KC Monitor/kim.inc`.
- If rebuilding the KC Monitor after that comment change yields a different `KC Monitor.bin`,
  something besides a comment moved. Do not bundle it here without its own review.

### 6502-BIOS

- Nothing to do. For the record: KIMULATOR takes its ROM from the `v1.x` line from now on, and
  a 1.6.x fix there is the only thing that would bring a new BIOS here.

---

## 9. Staying on 1.x for good

What keeps the decision true after 6502-BIOS `main` becomes 2.x:

- **`BundledROM.test.ts`** refuses any version string but `6502 BIOS v1.x` (§5.4).
- **`assets/roms/README.md`** names tag `v1.6` and branch `v1.x` as the source, never `main`
  (§5.5).
- **This file** says it in its header. `CLAUDE.md` could carry one line too ("the bundled BIOS
  comes from 6502-BIOS `v1.x`; the KIM never takes BIOS 2.x"). Add it in §5's commit if you
  want every future session to see it without opening this plan.

---

## 10. Risks and open questions

1. **The web build goes live at §5.8, before the release.** It's the same as past ROM bumps,
   and the only visible change on a KIM is the version number. Acceptable.
2. **Episode 14's captured footage shows `BIOS v1.5`**, and a viewer on 1.0.9 sees `v1.6`.
   Decided: the footage stays, and 6502-ASSEMBLY adds a note. Nothing here depends on it.
3. **Notarization and Docker** for `npm run dist` are environment-dependent and unverified
   from here, as in 6502-EMULATOR's plan.
4. **The shared origin.** KIMULATOR's web build shares `acwright.github.io` with 6502-EMULATOR
   and 6502-DOCS. This release changes no storage names, so nothing new is shared.
