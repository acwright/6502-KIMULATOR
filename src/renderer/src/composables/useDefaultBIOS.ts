import type { DefaultROMs } from '@shared/types'

/**
 * Fetch the ROM images bundled with the app.
 *
 * Two of them, because a KIM boots from two: the 32 KB `BIOS.bin`, of which
 * only $A000–$BFFF is on this machine's bus, and the Keypad Card's own 8 KB
 * `KCMonitor.bin`, which supplies $E000 upwards *and the reset vector*. A
 * machine given only the first has nothing to start from.
 *
 * - Electron: one IPC round trip; main reads both out of the app bundle.
 * - Web: fetched from the Vite public URL (BASE_URL + roms/…).
 *
 * Shared by the auto-boot sequence (App.vue) and the "reset to default" actions
 * in the settings panel. Cached, since both images are immutable build
 * artifacts and the panel would otherwise re-read them on every visit.
 */
const DEFAULT_ROM_FILE = 'BIOS.bin'
const DEFAULT_CARD_ROM_FILE = 'KCMonitor.bin'

export const DEFAULT_ROM_LABEL = 'BIOS (default)'
export const DEFAULT_CARD_ROM_LABEL = 'KC Monitor (default)'

let cached: Promise<DefaultROMs> | undefined

async function fetchWeb(file: string): Promise<Uint8Array | null> {
  const r = await fetch(import.meta.env.BASE_URL + `roms/${file}`)
  return r.ok ? new Uint8Array(await r.arrayBuffer()) : null
}

export function loadDefaultROMs(): Promise<DefaultROMs> {
  cached ??= (async () => {
    try {
      if (window.api) {
        const { bios, card } = await window.api.roms.loadDefaults()
        return { bios: bios ? new Uint8Array(bios) : null, card: card ? new Uint8Array(card) : null }
      }
      const [bios, card] = await Promise.all([
        fetchWeb(DEFAULT_ROM_FILE),
        fetchWeb(DEFAULT_CARD_ROM_FILE)
      ])
      return { bios, card }
    } catch (e) {
      console.warn('[useDefaultBIOS] loadDefaultROMs failed:', e)
      return { bios: null, card: null }
    }
  })()
  return cached
}

/** The BIOS image alone — the "reset ROM to default" action in Settings. */
export async function loadDefaultBIOS(): Promise<Uint8Array | null> {
  return (await loadDefaultROMs()).bios
}

/** The Keypad Card image alone — its own "reset to default" action. */
export async function loadDefaultCardROM(): Promise<Uint8Array | null> {
  return (await loadDefaultROMs()).card
}
