/**
 * The phase 6 exit criteria, run against the real firmware and the real cards.
 *
 * `LEDLatch.test.ts` tests the chip; this one keys the two type-in programs from
 * 6502-DOCS into a booted KIM and watches the lamps, because the exit criterion
 * is not "the latch latches" — that is settled next door — but "the cards work
 * as printed on a machine with the BIOS and the KC Monitor in it".
 *
 * It is the first test to take Snapshot.ts up on what it was written for: boot
 * the monitor once, save there, restore per case. The alternative is paying the
 * BIOS countdown and the LCD's four ~41 ms power-on delays — about 1.8 M cycles
 * — for every program run, and there are two programs and several ways to run
 * each.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine } from '../core/Machine'
import type { SlotConfig } from '../core/Machine'
import { LEDLatch } from '../core/accessories/LEDLatch'
import { keyForName } from '../core/KeypadMap'
import { captureSnapshot, restoreSnapshot } from '../debug/Snapshot'
import type { Snapshot } from '../debug/Snapshot'

const ROOT = join(__dirname, '../..')

/** Where KernalInit records what it found on the bus — BIOS.inc. */
const HW_PRESENT = 0x030d
const HW_SC = 0x10
const HW_GPIO = 0x20

/** Where the monitor starts, and where both cards say to type. */
const PROGRAM_START = 0x0800

const BIOS = readFileSync(join(ROOT, 'assets/roms/BIOS.bin'))
const KC_MONITOR = readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin'))

/**
 * The binary counter, transcribed from
 * `6502-DOCS/docs/public/cards/archive/kim-led-binary-counter.html`.
 *
 *   stz $36 / lda $36 / sta $9400 / lda #50 / ldx #0 / jsr SysDelay /
 *   inc $36 / bra
 */
const BINARY_COUNTER = [
  0x64, 0x36, 0xa5, 0x36, 0x8d, 0x00, 0x94, 0xa9,
  0x32, 0xa2, 0x00, 0x20, 0x75, 0xa0, 0xe6, 0x36,
  0x80, 0xf0
]

/**
 * The KITT scanner from the second card — 24 bytes of code and a 14-entry
 * one-hot table at $0818.
 */
const KITT_SCANNER = [
  0xa0, 0x00, 0xb9, 0x18, 0x08, 0x8d, 0x00, 0x94,
  0x5a, 0xa9, 0x0a, 0xa2, 0x00, 0x20, 0x75, 0xa0,
  0x7a, 0xc8, 0xc0, 0x0e, 0xd0, 0xec, 0x80, 0xe8,
  0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80,
  0x40, 0x20, 0x10, 0x08, 0x04, 0x02
]

/** The sweep the table describes: out to bit 7 and back, no double-tap at either end. */
const SWEEP = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02]

const build = (slots: SlotConfig = {}): Machine => {
  const machine = new Machine(slots)
  machine.loadROM(BIOS)
  machine.loadCardROM(KC_MONITOR)
  machine.resetCPU()
  return machine
}

const runUntil = (machine: Machine, done: () => boolean, budget = 4_000_000): boolean => {
  for (let spent = 0; spent < budget; spent += 25_000) {
    machine.runCycles(25_000)
    if (done()) return true
  }
  return false
}

const press = (machine: Machine, name: string): void => {
  const key = keyForName(name)
  if (key === undefined) throw new Error(`no key named ${name}`)
  machine.onKeypadDown(key.code)
  machine.runCycles(200_000)
}

/** The monitor's first painted screen, saved once and restored thereafter. */
let saved: Snapshot | null = null

/** A KIM with the LED latch on the bus, sitting at the monitor showing $0800. */
const fittedAtMonitor = (): { machine: Machine; latch: LEDLatch } => {
  const latch = new LEDLatch()
  const machine = build({ io6: latch })

  if (saved) {
    restoreSnapshot(machine, saved)
    return { machine, latch }
  }

  expect(runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))).toBe(true)
  press(machine, 'ESC')  // the splash gate: ESC, and nothing else, starts the monitor
  expect(runUntil(machine, () => machine.lcd.getRowText(0).includes('$'), 500_000)).toBe(true)

  saved = captureSnapshot(machine)
  return { machine, latch }
}

/** Type a card's bytes in at $0800. The pad would do this one nibble at a time. */
const keyIn = (machine: Machine, program: number[]): void => {
  program.forEach((byte, offset) => machine.poke(PROGRAM_START + offset, byte))
}

/**
 * Run, sampling the lamps, and return the values they took in order.
 *
 * Distinct consecutive values rather than one per sample: the programs hold each
 * pattern for 100-500 ms of emulated time, so sampling finely and collapsing
 * repeats is what turns "what the lamps did" into a sequence you can assert on.
 */
const watchLamps = (machine: Machine, latch: LEDLatch, cycles: number): number[] => {
  const seen: number[] = [latch.byte]
  for (let spent = 0; spent < cycles; spent += 20_000) {
    machine.runCycles(20_000)
    if (latch.byte !== seen[seen.length - 1]) seen.push(latch.byte)
  }
  return seen
}

describe('the KIM Demo LED accessory', () => {

  /**
   * The reason the latch reads back open bus, checked where it actually
   * matters: `ProbeGPIO` writes $AA to GPIO_DDRB — $9402, inside this card's
   * window — and reads it back. A card that echoed the write would set HW_GPIO
   * on a machine with no VIA in it, and `SysDelay` would then wait on a hardware
   * timer that is not there.
   */
  describe('the BIOS slot probe', () => {
    it('still finds the Serial Card and nothing else with the latch fitted', () => {
      const machine = build({ io6: new LEDLatch() })
      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))

      expect(machine.peek(HW_PRESENT)).toBe(HW_SC)
      expect(machine.peek(HW_PRESENT) & HW_GPIO).toBe(0)
    })

    /** And the probe's own $AA is on the lamps for a moment, as on the bench. */
    it('leaves the lamps dark once it has finished probing', () => {
      const latch = new LEDLatch()
      const machine = build({ io6: latch })
      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))

      expect(latch.byte).toBe(0x00)
    })
  })

  describe('the binary counter', () => {
    it('counts up on the lamps, one step at a time', () => {
      const { machine, latch } = fittedAtMonitor()
      keyIn(machine, BINARY_COUNTER)

      // The monitor is already at $0800 — ▲ runs from there.
      press(machine, 'UP')

      const seen = watchLamps(machine, latch, 3_000_000)
      expect(seen.slice(0, 5)).toEqual([0x00, 0x01, 0x02, 0x03, 0x04])
    })

    it('steps about twice a second', () => {
      const { machine, latch } = fittedAtMonitor()
      keyIn(machine, BINARY_COUNTER)
      press(machine, 'UP')

      // 50 centiseconds through SysDelay's software loop, at 1 MHz. The loop is
      // calibrated rather than exact, so this is a range and not a number.
      const before = machine.cycles
      const start = latch.byte
      runUntil(machine, () => latch.byte !== start, 1_000_000)
      const elapsed = machine.cycles - before

      expect(elapsed).toBeGreaterThan(300_000)
      expect(elapsed).toBeLessThan(700_000)
    })

    /**
     * ESC is caught in the KC Monitor's ISR, from anywhere — including from
     * inside a launched program, which is what makes it a panic button rather
     * than a menu item.
     */
    it('stops on ESC and comes back to the monitor', () => {
      const { machine, latch } = fittedAtMonitor()
      keyIn(machine, BINARY_COUNTER)
      press(machine, 'UP')
      machine.runCycles(1_000_000)

      press(machine, 'ESC')
      expect(machine.lcd.getRowText(0)).toContain('$')

      // The '373 has no clear pin, so whatever the program last wrote is still
      // on the lamps. Nothing stopped it but the CPU.
      const held = latch.byte
      machine.runCycles(1_000_000)
      expect(latch.byte).toBe(held)
    })
  })

  describe('the KITT scanner', () => {
    it('bounces one lamp out to bit 7 and back, over and over', () => {
      const { machine, latch } = fittedAtMonitor()
      keyIn(machine, KITT_SCANNER)
      press(machine, 'UP')

      // Long enough for more than one full sweep, so the wrap from the last
      // table entry back to the first is inside what is asserted.
      const lamps = watchLamps(machine, latch, 2_400_000).slice(1)
      expect(lamps.length).toBeGreaterThan(SWEEP.length)

      // Sampling starts wherever the keypress settle left the program, so the
      // claim is that the lamps follow the table in order and wrap — not that
      // they were caught at its first entry.
      const from = SWEEP.indexOf(lamps[0]!)
      expect(from).toBeGreaterThanOrEqual(0)
      expect(lamps).toEqual(lamps.map((_, i) => SWEEP[(from + i) % SWEEP.length]))
    })

    it('lights exactly one lamp at a time', () => {
      const { machine, latch } = fittedAtMonitor()
      keyIn(machine, KITT_SCANNER)
      press(machine, 'UP')

      for (const value of watchLamps(machine, latch, 800_000).slice(1)) {
        expect(value & (value - 1)).toBe(0)
        expect(value).not.toBe(0)
      }
    })
  })

  /**
   * The bay is part of the machine's shape, so a snapshot carries it — and
   * because an accessory's registry id *is* its `IO.kind`, the slot-layout check
   * that already refuses a differently-configured machine covers the bay for
   * free.
   */
  describe('snapshots', () => {
    it('restores the lamps as they were', () => {
      const { machine, latch } = fittedAtMonitor()
      machine.poke(0x9400, 0xa5)
      const snapshot = captureSnapshot(machine)

      const restored = new LEDLatch()
      const other = build({ io6: restored })
      restoreSnapshot(other, snapshot)

      expect(restored.byte).toBe(0xa5)
      expect(latch.byte).toBe(0xa5)
    })

    it('refuses to restore a fitted bay into an empty one', () => {
      const { machine } = fittedAtMonitor()
      const snapshot = captureSnapshot(machine)

      expect(() => restoreSnapshot(build(), snapshot)).toThrow(/io6/)
    })

    it('refuses to restore an empty bay into a fitted one', () => {
      const snapshot = captureSnapshot(build())

      expect(() => restoreSnapshot(build({ io6: new LEDLatch() }), snapshot)).toThrow(/io6/)
    })
  })

})
