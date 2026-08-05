import { ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useSerial } from '@/composables/useSerial'
import { bootPayload } from '@/composables/useBoot'
import {
  loadDefaultROMs,
  DEFAULT_ROM_LABEL,
  DEFAULT_CARD_ROM_LABEL
} from '@/composables/useDefaultBIOS'
import { DEFAULT_APP_SETTINGS } from '@shared/types'
import type { AppSettings } from '@shared/types'

/**
 * Building the machine, and rebuilding it when its shape changes.
 *
 * A card cannot be fitted or pulled with the power on, so fitting the Serial
 * Card or wiring something to the accessory bay means constructing a *new*
 * Machine rather than mutating the one on the bench. Which in turn means
 * whatever firmware was loaded has to go back in: the images live with whoever
 * fetched them, so this is where they are remembered.
 *
 * App.vue's auto-boot and the Settings panel's toggles are the same sequence
 * with different arguments, and having one of them here rather than two of them
 * spelled out separately is what keeps a rebuilt machine identical to a
 * freshly-launched one.
 */

interface Image {
  bytes: Uint8Array
  label: string
}

/** The images currently in the machine, so a rebuild puts the same ones back. */
const rom = ref<Image | null>(null)
const cardROM = ref<Image | null>(null)

/** The shape the machine was last built with. */
const shape = ref<{ serialCard: boolean }>({ serialCard: true })

export function useMachine() {
  const store = useEmulatorStore()
  const serial = useSerial()

  /** Put a 32 KB BIOS image in, and remember it for the next rebuild. */
  function setROM(bytes: Uint8Array, label: string): void {
    rom.value = { bytes, label }
    store.loadROM(bytes, label)
    store.resetCPU()
  }

  /**
   * Put the Keypad Card's own 8 KB image in. Not a cartridge load — there is no
   * slot and no state in which the card is absent; it is how a freshly built
   * `KC Monitor.bin` gets tried without burning an AT28C64. The reset that
   * follows is not optional: this ROM is where the vectors live.
   */
  function setCardROM(bytes: Uint8Array, label: string): void {
    cardROM.value = { bytes, label }
    store.loadCardROM(bytes, label)
    store.resetCPU()
  }

  /**
   * Construct a machine of the given shape and put the firmware back in.
   *
   * Cold by definition: a new Machine has new RAM, which is exactly what pulling
   * a card and powering back up gives you on the bench.
   */
  function rebuild(next: Partial<{ serialCard: boolean }> = {}): void {
    const wasRunning = store.isRunning
    shape.value = { ...shape.value, ...next }

    // The accessory bay stays empty until phase 6 supplies a registry to look
    // `settings.accessory` up in.
    store.init({ serialCard: shape.value.serialCard })

    if (rom.value) store.loadROM(rom.value.bytes, rom.value.label)
    if (cardROM.value) store.loadCardROM(cardROM.value.bytes, cardROM.value.label)
    store.resetCPU()

    if (wasRunning) store.run()
  }

  /**
   * The auto-boot sequence: settings, machine, firmware, then power.
   *
   * The order matters at one point only, and it is the one that makes this a
   * KIM: the Keypad Card's ROM is where the reset vector lives, so the CPU has
   * nothing to start from until that image is in and the vectors have been
   * re-read.
   */
  async function boot(): Promise<AppSettings> {
    // 0. What `6502-kim run` launched this window with, if it did. Null
    //    otherwise, and every step below then behaves exactly as it always has.
    const launch = await bootPayload()
    for (const problem of launch?.errors ?? []) console.error('[boot]', problem)

    // 1. Settings, so the machine is built the right shape and at the right
    //    frequency. Anything `6502-kim run` set — --freq, --baud, --accessory —
    //    is already folded in here by main, for this launch only.
    let settings: AppSettings = DEFAULT_APP_SETTINGS
    if (window.api) {
      try {
        settings = await window.api.settings.get()
      } catch {
        /* use defaults */
      }
    }
    store.setFrequency(settings.frequency)

    // 2. Build the machine. The Serial Card is the one card that is genuinely
    //    optional — unfitting it is how the keypad-only path the KC Monitor
    //    supports gets exercised.
    shape.value = { serialCard: settings.serialCardFitted }
    store.init({ serialCard: settings.serialCardFitted })

    // 3. Firmware. Both images; the command line's win over the bundled ones.
    const defaults = await loadDefaultROMs()

    const bios =
      launch?.rom ?? (defaults.bios ? { bytes: defaults.bios, label: DEFAULT_ROM_LABEL } : null)
    if (bios) {
      rom.value = bios
      store.loadROM(bios.bytes, bios.label)
    } else {
      console.warn('[boot] BIOS not loaded — the Kernal window will read as zeros')
    }

    const card =
      launch?.cardROM ??
      (defaults.card ? { bytes: defaults.card, label: DEFAULT_CARD_ROM_LABEL } : null)
    if (card) {
      cardROM.value = card
      store.loadCardROM(card.bytes, card.label)
    } else {
      console.warn('[boot] KC Monitor not loaded — the machine has no firmware to reset into')
    }

    // Re-read the reset vector now both images are in place, instead of the
    // uninitialised address the CPU reset to when the machine was constructed.
    store.resetCPU()

    // 3b. Anything else the command line attached. After the reset, not before —
    //     a reset does not clear RAM, but a power cycle would, and keeping the
    //     order "firmware, reset, then RAM" is what makes that safe to change.
    for (const { address, media } of launch?.binaries ?? []) {
      store.loadBinary(media.bytes, address, media.label)
    }

    // 3c. `--serial <port>`: bridge the ACIA to real hardware before the machine
    //     starts, so nothing the firmware says on the way up is lost.
    if (launch?.serialPort) {
      await serial.connect(settings.serialConfig, launch.serialPort)
    }

    // 4. Auto-start: simulates pressing the power button on the real machine.
    //    `--pause` holds the CPU at reset instead, so a debugger can attach
    //    before the first instruction; the Run button releases it.
    if (!launch?.pause) store.run()

    return settings
  }

  return { boot, rebuild, setROM, setCardROM, rom, cardROM }
}
