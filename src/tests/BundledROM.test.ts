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
    // 6502-BIOS tag v1.6 (8acb4fc1d410f523a0ba64308ac1c1d9e22098a2), the 1.x line: 1.6 reissued in
    // place with the four serial flow-control fixes the bench found against a real R6551 — RTS
    // lowered around each byte sent (water marks $C0 up, $80 down), the console quiet above the high
    // mark, the input ring never lapping its reader, and the IRQ handler reading the data register
    // only when a byte is really there
    sha256: '4b4154afac681e26324d3f5a845e41770d977c05db1ef6516c9d2c5e210d8c56',
    // Guards against bundling a truncated or unrelated binary. The KIM stays on
    // BIOS 1.x permanently, so a 2.x ROM must fail here rather than ship.
    version: /6502 BIOS v1\.\d+/
  },
  {
    name: 'KCMonitor.bin',
    bytes: 8192,
    // 6502-KIM @ 53cb4e15b403e3e6ebab13dae4afc66ac483291f — the first image since the monitor
    // shipped that is not the byte-frozen one: the serial console now takes the Kernal's RTS
    // scheme (up at $C0 unread bytes, down below $80, lowered around each byte sent and held up
    // instead of sent while flooded), drains its receive ring dry per loop pass and repaints the
    // LCD once, and drops an incoming byte rather than lapping the reader on a full ring
    sha256: '19c7ed60cd66f7e96c95581e603a5817fb8e75d386ebb3346c7b6478713d26f4',
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
