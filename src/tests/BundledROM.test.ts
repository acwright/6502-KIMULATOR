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
    // 6502-BIOS v1.x @ f858890 (f858890ef8da6014633b392fb76e22a496641fef), the 1.x line: 1.6 with the
    // serial output path dropping RTS around each byte, so a full input buffer cannot stop the
    // transmitter (water marks $C0 up, $80 down)
    sha256: '29ed506f99a5b8a296d449ed925f66186bbe7b012b7bb0d1e54fa768bbedd11a',
    // Guards against bundling a truncated or unrelated binary. The KIM stays on
    // BIOS 1.x permanently, so a 2.x ROM must fail here rather than ship.
    version: /6502 BIOS v1\.\d+/
  },
  {
    name: 'KCMonitor.bin',
    bytes: 8192,
    // 6502-KIM @ 3b5aa805085d55ef3d1a3291c635ce97485b49ad
    sha256: '06601fb6d962b01266988e6a78a962cad03392c6850d1a510455193c8db40aaf',
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
