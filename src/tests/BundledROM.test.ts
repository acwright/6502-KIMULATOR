/**
 * The KIM boots two ROMs, and each ships twice because two builds load it from
 * two places:
 *
 *   assets/roms/                 Electron and the CLI, via extraResources
 *   src/renderer/public/roms/    the web build, fetched from BASE_URL + roms/…
 *
 * Updating one copy and not the other ships a desktop app running different
 * firmware from the browser build, and every other test would go on passing.
 *
 * Both images are build artifacts of other repositories and are never edited
 * here — assets/roms/README.md names the commit each was taken from. The digests
 * below are that record made executable: re-copying a ROM is meant to be a
 * deliberate act that updates the README and this file together.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '../..')

const ROMS = [
  {
    name: 'BIOS.bin',
    bytes: 32768,
    // 6502-BIOS tag v1.7 (387d29d5396b821568e7b9a41fa7e7fccf6d1b76), the 1.x line: 1.6's serial
    // flow control, plus a SID probe that no longer takes an empty slot's open bus for a SID and a
    // CF probe that recognises an empty slot, waits up to 3.0 s for a card, and records how long
    sha256: '49be5865bde74220f37ad10bd773619b17f052b37c89f79c1a3564b7da51d799',
    // Guards against bundling a truncated or unrelated binary. The KIM stays on
    // BIOS 1.x permanently, so a 2.x ROM must fail here rather than ship.
    version: /6502 BIOS v1\.\d+/
  },
  {
    name: 'KCMonitor.bin',
    bytes: 8192,
    // 6502-KIM @ b01b5dcda9409385188abab4ec47bed237dac3c0 — KC Monitor v1.1: serial R waits for
    // the ACIA to take the monitor's last byte before calling the program, so the program's first
    // Chrout no longer overwrites it; with 53cb4e1's RTS scheme and receive ring
    sha256: '4defbbea6dca97fde50c69a5bdd9c584c946b0010003fc2aaa66ba78a1d015a0',
    version: /KIM MONITOR v\d+\.\d+/
  }
]

const electronPath = (name: string): string => join(ROOT, 'assets/roms', name)
const webPath = (name: string): string => join(ROOT, 'src/renderer/public/roms', name)

describe.each(ROMS)('bundled $name', ({ name, bytes, sha256, version }) => {
  it('is byte-identical in the Electron and web asset paths', () => {
    expect(readFileSync(electronPath(name)).equals(readFileSync(webPath(name)))).toBe(true)
  })

  it(`is a full ${bytes / 1024}K image`, () => {
    expect(readFileSync(webPath(name)).length).toBe(bytes)
  })

  it('matches the digest recorded in assets/roms/README.md', () => {
    const digest = createHash('sha256').update(readFileSync(webPath(name))).digest('hex')
    expect(digest).toBe(sha256)
  })

  it('carries the version string it should', () => {
    expect(readFileSync(webPath(name)).toString('latin1')).toMatch(version)
  })
})
