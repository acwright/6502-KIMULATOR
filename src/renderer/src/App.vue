<script setup lang="ts">
/**
 * The KIMulator window.
 *
 * The grid is the layout the finished app uses — terminal top-left, LCD
 * top-right, keys beneath the LCD, accessory beneath the terminal, control bar
 * across the bottom. Each region is filled in by phase 5; until then it names
 * itself, and the machine behind it runs the KC Monitor for real.
 */
import { onMounted, onUnmounted } from 'vue'
import { useSerial } from '@/composables/useSerial'
import { useDebugBridge } from '@/composables/useDebugBridge'
import {
  loadDefaultROMs,
  DEFAULT_ROM_LABEL,
  DEFAULT_CARD_ROM_LABEL
} from '@/composables/useDefaultBIOS'
import { bootPayload } from '@/composables/useBoot'
import { useEmulatorStore } from '@/stores/emulator'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

const regions = [
  { key: 'terminal', title: 'TERMINAL', note: '40 × 24, white on black', area: 'terminal' },
  { key: 'lcd', title: 'LCD', note: '16 × 2 HD44780', area: 'lcd' },
  { key: 'keys', title: 'KEYS', note: '24-key pad, 4 × 6', area: 'keys' },
  { key: 'accessory', title: 'ACCESSORY', note: 'the bus at $9400', area: 'accessory' }
]

const store = useEmulatorStore()
// Held here for the app's lifetime: the machine's serial link belongs to the
// machine, not to whichever panel happens to be open (see useSerial).
const serial = useSerial()

// Registers onUnmounted, so this must run during setup rather than from
// inside the async onMounted below — see useDebugBridge's own doc comment.
useDebugBridge()

// ── Mount: auto-boot sequence ─────────────────────────────────────────────────

onMounted(async () => {
  // 0. What `6502-kim run` launched this window with, if it did. Null otherwise,
  //    and every step below then behaves exactly as it always has.
  const boot = await bootPayload()
  for (const problem of boot?.errors ?? []) console.error('[boot]', problem)

  // 1. Settings, so the machine is built the right shape and at the right
  //    frequency. Anything `6502-kim run` set — --freq, --baud, --accessory — is
  //    already folded in here by main, for this launch only, so there is nothing
  //    special to do with it either here or in the Settings panel.
  let settings: AppSettings = DEFAULT_APP_SETTINGS
  if (window.api) {
    try {
      settings = await window.api.settings.get()
    } catch { /* use defaults */ }
  }
  store.setFrequency(settings.frequency)

  // 2. Build the machine. The Serial Card is the one card that is genuinely
  //    optional — unfitting it is how the keypad-only path the KC Monitor
  //    supports gets exercised. The accessory bay stays empty until phase 6
  //    supplies a registry to look `settings.accessory` up in.
  store.init({ serialCard: settings.serialCardFitted })

  // 3. Firmware. Both images, and in this order: the Keypad Card's ROM is where
  //    the reset vector lives, so the CPU has nothing to start from until it is
  //    in. The command line's images win over the bundled ones.
  const defaults = await loadDefaultROMs()

  const rom = boot?.rom ?? (defaults.bios ? { bytes: defaults.bios, label: DEFAULT_ROM_LABEL } : null)
  if (rom) store.loadROM(rom.bytes, rom.label)
  else console.warn('[App] BIOS not loaded — the Kernal window will read as zeros')

  const cardROM =
    boot?.cardROM ?? (defaults.card ? { bytes: defaults.card, label: DEFAULT_CARD_ROM_LABEL } : null)
  if (cardROM) store.loadCardROM(cardROM.bytes, cardROM.label)
  else console.warn('[App] KC Monitor not loaded — the machine has no firmware to reset into')

  // Re-read the reset vector now both images are in place, instead of the
  // uninitialised address the CPU reset to when the machine was constructed.
  store.resetCPU()

  // 3b. Anything else the command line attached. After the reset, not before —
  //     a reset does not clear RAM, but a power cycle would, and keeping the
  //     order "firmware, reset, then RAM" is what makes that safe to change.
  for (const { address, media } of boot?.binaries ?? []) {
    store.loadBinary(media.bytes, address, media.label)
  }

  // 3c. `--serial <port>`: bridge the ACIA to real hardware before the machine
  //     starts, so nothing the firmware says on the way up is lost.
  if (boot?.serialPort) {
    await serial.connect(settings.serialConfig, boot.serialPort)
  }

  // 4. Auto-start: simulates pressing the power button on the real machine.
  //    `--pause` holds the CPU at reset instead, so a debugger can attach
  //    before the first instruction; the Run button releases it.
  if (!boot?.pause) store.run()

  // 5. F11 / Cmd+Enter — fullscreen toggle (Electron only). Global on purpose:
  //    phase 5's focus router routes everything else by panel, but this one
  //    belongs to the window rather than to whatever has the keyboard.
  const onFullscreenKey = (e: KeyboardEvent) => {
    if (e.key === 'F11' || (e.metaKey && e.key === 'Enter')) {
      e.preventDefault()
      window.api?.window.toggleFullscreen()
    }
  }
  window.addEventListener('keydown', onFullscreenKey, true)

  onUnmounted(() => {
    window.removeEventListener('keydown', onFullscreenKey, true)
  })
})
</script>

<template>
  <div class="flex h-full flex-col bg-black text-white">
    <div class="kim-grid min-h-0 flex-1 gap-px bg-neutral-800 p-px">
      <section
        v-for="region in regions"
        :key="region.key"
        :style="{ gridArea: region.area }"
        class="flex flex-col items-center justify-center bg-black"
      >
        <h1 class="text-sm tracking-[0.3em] text-neutral-500">{{ region.title }}</h1>
        <p class="mt-1 text-xs text-neutral-700">{{ region.note }}</p>
      </section>
    </div>

    <footer
      class="flex h-10 shrink-0 items-center justify-center border-t border-neutral-800 bg-black text-xs tracking-[0.3em] text-neutral-700"
    >
      CONTROL BAR
    </footer>
  </div>
</template>

<style scoped>
.kim-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  grid-template-rows: 3fr 2fr;
  grid-template-areas:
    'terminal lcd'
    'accessory keys';
}
</style>
