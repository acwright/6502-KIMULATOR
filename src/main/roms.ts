import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { DefaultROMs } from '../shared/types'

const BIOS_FILE = 'BIOS.bin'
const CARD_ROM_FILE = 'KCMonitor.bin'

/**
 * Reads the ROM images shipped with the app.
 *
 * All that survives of the ACE's StorageService: a KIM has no CF card and no
 * NVRAM to persist, and it loses its RAM when you switch it off exactly as the
 * real one does. What is left is the one thing the renderer genuinely cannot do
 * for itself — read a file off disk.
 *
 * Two images, not one. The Keypad Card is not a cartridge: it carries its own
 * 8 KB ROM and the vectors the CPU fetches at reset, so a machine given only
 * `BIOS.bin` has nothing to start from.
 */
export class RomService {
  /**
   * Where the images live. In development, relative to the repo root; in a
   * packaged build, `process.resourcesPath`, where electron-builder's
   * `extraResources` puts `assets/`.
   */
  private romPath(file: string): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'assets', 'roms', file)
      : join(__dirname, '..', '..', 'assets', 'roms', file)
  }

  private read(file: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(this.romPath(file)))
    } catch (e) {
      console.error(`[roms] ${file}:`, e)
      return null
    }
  }

  loadDefaults(): DefaultROMs {
    return { bios: this.read(BIOS_FILE), card: this.read(CARD_ROM_FILE) }
  }
}
