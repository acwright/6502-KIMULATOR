import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Machine } from '@core/Machine'
import type { SlotConfig } from '@core/Machine'
import { Session } from '@debug/Session'
import { Empty } from '@core/IO/Empty'
import { ACIA } from '@core/IO/ACIA'
import type { PIA } from '@core/IO/PIA'
import type { KeypadAttachment } from '@core/IO/Attachments/KeypadAttachment'
import type { LCDAttachment } from '@core/IO/Attachments/LCDAttachment'
import type { IO } from '@core/IO'
import { loadBinary as writeBinary } from '@core/ProgramImage'

/** How the machine is built. Everything else about it is fixed hardware. */
export interface MachineOptions {
  /**
   * Whether the Serial Card sits in io5. `false` gives the keypad-only machine
   * the KC Monitor explicitly supports — it guards every ACIA access on
   * `HW_PRESENT & HW_SC`, so this is a configuration to exercise, not a fault.
   */
  serialCard?: boolean
  /** The card wired to the accessory bus at io6. The bay is empty by default. */
  accessory?: IO
}

export const useEmulatorStore = defineStore('emulator', () => {
  // The Session owns forward progress; the store exposes the machine for the
  // components and composables that read or poke its hardware directly.
  const session = shallowRef<Session | null>(null)
  const machine = shallowRef<Machine | null>(null)
  const isRunning = ref(false)
  /**
   * The program executed STP, so the CPU cannot advance again until it is reset.
   *
   * Tracked off the Session's stop announcement rather than read from
   * `machine.cpu.stopped`: `machine` is a shallowRef over the emulator core, and
   * nothing in there is reactive, so a computed on that field would never
   * re-evaluate.
   */
  const isHalted = ref(false)
  const serialConnected = ref(false)
  /** Whether the machine currently on the bench was built with a Serial Card. */
  const serialCardFitted = ref(true)
  // Display labels for currently loaded files (shown in SettingsPanel).
  const romName = ref<string>('BIOS (default)')
  const cardROMName = ref<string>('KC Monitor (default)')
  const binaryName = ref<string | null>(null)
  // Message from the most recent binary load; null when it went cleanly.
  const loadWarning = ref<string | null>(null)

  /**
   * Everything watching the byte stream the ACIA transmits.
   *
   * A set rather than one callback because the terminal panel is a *tap* on that
   * stream, not a second device: what the machine says goes to the panel and,
   * when a real port is open, down the cable as well. With a single slot the two
   * would evict each other, and connecting a laptop would blank the window.
   */
  const transmitTaps = new Set<(data: number) => void>()

  const fanOut = (byte: number) => {
    for (const tap of transmitTaps) tap(byte)
  }

  /** Watch the transmitted byte stream. Returns an unsubscribe. */
  function onTransmit(tap: (data: number) => void): () => void {
    transmitTaps.add(tap)
    return () => {
      transmitTaps.delete(tap)
    }
  }

  /**
   * Build the machine.
   *
   * Safe to call again: a card cannot be fitted or pulled with the power on, so
   * changing the machine's shape means building a new one. Whoever calls it a
   * second time owns re-loading the ROMs — the images live with the caller that
   * fetched them, not in here.
   */
  function init(options: MachineOptions = {}) {
    const { serialCard = true, accessory } = options

    // Six of the eight windows are vacant on a KIM and stay that way. Only io5
    // and io6 are ever named here, and both can be empty.
    const slots: SlotConfig = {
      io5: serialCard ? new ACIA() : new Empty(),
      io6: accessory ?? new Empty()
    }

    // PHI2 is not configurable: 1 MHz is what this board runs at, and Machine
    // starts there. The 2 MHz jumper belongs to the ACE.
    const s = new Session(slots)
    const m = s.machine

    s.onStop((reason) => {
      if (reason.kind !== 'trap' || reason.detail !== 'stp') return
      isHalted.value = true
      // The scheduler has already stopped; the toolbar would otherwise still be
      // offering a Stop button for a machine that is no longer going anywhere.
      isRunning.value = false
    })

    m.transmit = fanOut

    serialCardFitted.value = serialCard
    isHalted.value = false
    isRunning.value = false
    session.value = s
    machine.value = m
  }

  /** Load a 32 KB BIOS image. Follow with resetCPU(). */
  function loadROM(data: Uint8Array | ArrayBuffer, label?: string) {
    machine.value?.loadROM(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (label !== undefined) romName.value = label
  }

  /**
   * Load the Keypad Card's own 8 KB image. Follow with resetCPU() — this is the
   * ROM the CPU fetches its vectors from, so replacing it moves the entry point.
   *
   * Not a cartridge load: there is no slot, and no state in which the card is
   * absent. It is how a freshly built `KC Monitor.bin` gets tried without
   * burning an AT28C64.
   */
  function loadCardROM(data: Uint8Array | ArrayBuffer, label?: string) {
    machine.value?.loadCardROM(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (label !== undefined) cardROMName.value = label
  }

  const hex = (address: number) => address.toString(16).toUpperCase().padStart(4, '0')

  /**
   * Load raw bytes at an explicit address — the type-in cards without the
   * typing, and the only kind of program this machine loads.
   */
  function loadBinary(data: Uint8Array | ArrayBuffer, address: number, label?: string) {
    const m = machine.value
    if (!m) return
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data

    switch (writeBinary(m, address, bytes)) {
      case 'empty':
        loadWarning.value = 'Binary file is empty — nothing loaded.'
        return
      case 'out-of-range':
        loadWarning.value =
          `${bytes.length} bytes at $${hex(address)} runs past the top of RAM ($7FFF). Nothing loaded.`
        return
      case 'ok':
        loadWarning.value = null
        break
    }

    if (label !== undefined) binaryName.value = `${label} @ $${hex(address)}`
  }

  function run() {
    session.value?.run('realtime')
    isRunning.value = true
  }

  function stop() {
    session.value?.pause()
    isRunning.value = false
  }

  // Models the physical reset button, which only pulses the CPU RESET line —
  // SRAM keeps its contents, so anything keyed in survives, exactly as on
  // hardware.
  function reset() {
    // RESET is the only thing that lifts STP, which is the whole reason the
    // halted state is worth surfacing on the toolbar.
    isHalted.value = false
    session.value?.reset(false)
  }

  /** Models a power cycle: RAM is zeroed and the monitor cold-boots. */
  function powerCycle() {
    isHalted.value = false
    binaryName.value = null
    loadWarning.value = null
    session.value?.reset(true)
  }

  /**
   * Warm-reset the CPU so it re-reads the reset vector from the Keypad Card's
   * ROM. What loading either image has to be followed by.
   */
  function resetCPU() {
    reset()
  }

  /**
   * Press a key on the pad, by its encoder code — see KeypadMap.
   *
   * There is no `releaseKey`. The 74C922 reports the press and nothing else, so
   * neither does this.
   */
  function pressKey(code: number) {
    machine.value?.onKeypadDown(code)
  }

  /** The 16×2 HD44780 on the Keypad Card. Never absent — it is not in a slot. */
  function getLCD(): LCDAttachment | null {
    return machine.value?.lcd ?? null
  }

  /** The 65C21 the pad and the LCD hang off. */
  function getPIA(): PIA | null {
    return machine.value?.pia ?? null
  }

  function getKeypad(): KeypadAttachment | null {
    return machine.value?.keypad ?? null
  }

  /** Whatever is wired to the accessory bus at $9400, or null for an empty bay. */
  function getAccessory(): IO | null {
    const io6 = machine.value?.io6
    return !io6 || io6 instanceof Empty ? null : io6
  }

  /** The Serial Card, or null on a keypad-only machine. */
  function getACIA(): ACIA | null {
    return machine.value?.acia() ?? null
  }

  return {
    session,
    machine,
    isRunning,
    isHalted,
    serialConnected,
    serialCardFitted,
    romName,
    cardROMName,
    binaryName,
    loadWarning,
    init,
    loadROM,
    loadCardROM,
    loadBinary,
    run,
    stop,
    reset,
    powerCycle,
    resetCPU,
    pressKey,
    getLCD,
    getPIA,
    getKeypad,
    getAccessory,
    getACIA,
    onTransmit,
  }
})
