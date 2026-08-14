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
    // 6502-BIOS @ d1fcefe0725aac033126a529e135675b1624f6c8
    sha256: 'ecd753a22d9ac5e91653d0f4c20ddd5df38637f2a95a6e11b89f3e1ab71203ca',
    // Guards against bundling a truncated or unrelated binary.
    version: /6502 BIOS v\d+\.\d+/
  },
  {
    name: 'KCMonitor.bin',
    bytes: 8192,
    // 6502-KIM @ 79a4e4804c2f575388f46b23fc11e13900303f47
    sha256: '029fb5bd9cbddab3b1547bb625725795b98a3647d4934dba59f30bb3e7e4e692',
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
