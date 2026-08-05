import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine } from '../../core/Machine'
import type { SlotConfig } from '../../core/Machine'
import { CardROM } from '../../core/CardROM'
import { ACIA } from '../../core/IO/ACIA'
import { Empty } from '../../core/IO/Empty'
import { Session } from '../../debug/Session'
import {
  captureSnapshot,
  restoreSnapshot,
  StateError,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION
} from '../../debug/Snapshot'
import type { Snapshot } from '../../debug/Snapshot'
import { keyForName } from '../../core/KeypadMap'

const ROOT = join(__dirname, '../../..')
const BIOS = readFileSync(join(ROOT, 'assets/roms/BIOS.bin'))
const KC_MONITOR = readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin'))

/**
 * A KIM as it is actually built, with both ROMs in it.
 *
 * Where 6502-EMULATOR's fixture has to choose a console and fit a small CF card,
 * this one has nothing to decide: seven slots are `Empty` because the machine has
 * nothing to put in them, and the two devices that matter are on the Keypad Card,
 * which is not in a slot and cannot be left out.
 */
function machine(overrides: SlotConfig = {}): Machine {
  const m = new Machine(overrides)
  m.loadROM(BIOS)
  m.loadCardROM(KC_MONITOR)
  m.reset(true)
  return m
}

/** JSON round-trip, so a test is asserting on what a client would receive. */
const wire = (snapshot: Snapshot): Snapshot => JSON.parse(JSON.stringify(snapshot)) as Snapshot

/** A card ROM one byte different from the bundled one. */
function patchedCardROM(): Uint8Array {
  const patched = new Uint8Array(KC_MONITOR)
  patched[0x100] = patched[0x100]! ^ 0xff
  return patched
}

describe('Snapshot', () => {
  describe('envelope', () => {
    it('stamps the format, version and clock', () => {
      const m = machine()
      m.frequency = 2_000_000

      const snapshot = captureSnapshot(m)

      expect(snapshot.format).toBe(SNAPSHOT_FORMAT)
      expect(snapshot.version).toBe(SNAPSHOT_VERSION)
      expect(snapshot.frequency).toBe(2_000_000)
      expect(snapshot.slots).toHaveLength(8)
      expect(Date.parse(snapshot.createdAt)).not.toBeNaN()
    })

    it('survives a JSON round trip', () => {
      const m = machine()
      m.runCycles(5000)

      const restored = machine()
      expect(() => restoreSnapshot(restored, wire(captureSnapshot(m)))).not.toThrow()
      expect(restored.cpu.pc).toBe(m.cpu.pc)
    })

    it('refuses anything that is not a snapshot', () => {
      const m = machine()
      expect(() => restoreSnapshot(m, { hello: 'world' })).toThrow(StateError)
      expect(() => restoreSnapshot(m, null)).toThrow(/expected an object/)
      expect(() => restoreSnapshot(m, [])).toThrow(/expected an object/)
    })

    it('names the field when the envelope is malformed', () => {
      const m = machine()
      const good = captureSnapshot(m)

      const cases: [unknown, RegExp][] = [
        [{ ...good, frequency: '1MHz' }, /snapshot\.frequency/],
        [{ ...good, rom: undefined }, /snapshot\.rom/],
        [{ ...good, rom: { length: 0x8000 } }, /snapshot\.rom/],
        [{ ...good, cardROM: undefined }, /snapshot\.cardROM/],
        [{ ...good, cardROM: { crc32: 'abcdef01' } }, /snapshot\.cardROM/],
        [{ ...good, slots: good.slots.slice(0, 4) }, /snapshot\.slots: expected 8/],
        [{ ...good, slots: [...good.slots.slice(0, 7), null] }, /snapshot\.slots\[7\]/],
        [{ ...good, slots: [...good.slots.slice(0, 7), {}] }, /snapshot\.slots\[7\]/],
        [{ ...good, cpu: null }, /snapshot\.cpu/],
        [{ ...good, ram: { data: '' } }, /snapshot\.ram/],
        [{ ...good, pia: undefined }, /snapshot\.pia/]
      ]

      for (const [snapshot, message] of cases) {
        expect(() => restoreSnapshot(machine(), snapshot)).toThrow(message)
      }
    })

    it('refuses a version it does not read, rather than restoring most of it', () => {
      const m = machine()
      const snapshot = { ...captureSnapshot(m), version: SNAPSHOT_VERSION + 1 }

      expect(() => restoreSnapshot(machine(), snapshot)).toThrow(
        new RegExp(`version ${SNAPSHOT_VERSION + 1}.*reads version ${SNAPSHOT_VERSION}`)
      )
    })

    it('is not interchangeable with a 6502-EMULATOR snapshot', () => {
      const snapshot = { ...captureSnapshot(machine()), format: '6502-emulator-snapshot' }
      expect(() => restoreSnapshot(machine(), snapshot)).toThrow(/not a 6502-KIM snapshot/)
    })
  })

  describe('machine identity', () => {
    it('refuses a snapshot taken against a different BIOS', () => {
      const snapshot = captureSnapshot(machine())

      const other = new Machine()
      const patched = new Uint8Array(BIOS)
      patched[0x100] = patched[0x100]! ^ 0xff
      other.loadROM(patched)
      other.loadCardROM(KC_MONITOR)
      other.reset(true)

      expect(() => restoreSnapshot(other, snapshot)).toThrow(/different BIOS ROM/)
    })

    /**
     * The check that matters most on this machine.
     *
     * The KC Monitor is developed in the sibling repository and rebuilt often, so
     * "restore yesterday's session onto today's firmware" is not a hypothetical
     * mistake — it is the ordinary Tuesday one, and the PC in the snapshot points
     * into an image that has since moved.
     */
    it('refuses a snapshot taken against a different Keypad Card ROM', () => {
      const snapshot = captureSnapshot(machine())

      const other = new Machine()
      other.loadROM(BIOS)
      other.loadCardROM(patchedCardROM())
      other.reset(true)

      expect(() => restoreSnapshot(other, snapshot)).toThrow(/different Keypad Card ROM/)
    })

    it('restores against a different ROM when forced, and says which one', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = captureSnapshot(m)

      const other = new Machine()
      other.loadROM(BIOS)
      other.loadCardROM(patchedCardROM())
      other.reset(true)

      const result = restoreSnapshot(other, snapshot, { force: true })

      expect(result.romMismatch).toBeUndefined()
      expect(result.cardROMMismatch?.expected.crc32).toBe(snapshot.cardROM.crc32)
      expect(result.cardROMMismatch?.actual.crc32).not.toBe(snapshot.cardROM.crc32)
      expect(other.cpu.pc).toBe(m.cpu.pc)
    })

    /**
     * Where the cartridge image would be, and deliberately is not.
     *
     * 6502-EMULATOR stores the cart in full because a cart can be swapped while
     * the machine runs. Nothing here can be — the card is soldered in — so an
     * identity is enough, and it keeps the snapshot 8 KB smaller than it would
     * otherwise be.
     */
    it('carries the card ROM by identity, not by content', () => {
      const snapshot = wire(captureSnapshot(machine()))

      expect(snapshot.cardROM.length).toBe(CardROM.SIZE)
      expect(snapshot.cardROM.crc32).toMatch(/^[0-9a-f]{8}$/)
      expect(JSON.stringify(snapshot)).not.toContain('cart')
    })

    it('refuses a snapshot from a different slot layout', () => {
      const withSerial = captureSnapshot(machine())

      const keypadOnly = machine({ io5: new Empty() })

      expect(() => restoreSnapshot(keypadOnly, withSerial)).toThrow(
        /io5 holds a empty card, the snapshot has acia/
      )
    })

    it('checks the layout before writing any of it', () => {
      const m = machine()
      m.runCycles(20_000)
      const snapshot = captureSnapshot(m)
      // Only io5 disagrees, so a restore that wrote as it went would already
      // have replaced RAM and the CPU by the time it noticed.
      snapshot.slots[4] = { kind: 'empty' }

      const target = machine()
      const pcBefore = target.cpu.pc
      expect(() => restoreSnapshot(target, snapshot)).toThrow(StateError)
      expect(target.cpu.pc).toBe(pcBefore)
    })
  })

  describe('the Keypad Card', () => {
    /**
     * The card serializes as one field because it is one chip with two things
     * hanging off it. Both peripherals have to come back through the PIA's own
     * state, or a snapshot taken with a character half-written to the LCD loses
     * it.
     */
    it('carries the PIA, and the keypad and LCD inside it', () => {
      const state = captureSnapshot(machine()).pia

      expect(state.kind).toBe('pia')
      expect((state.portA as unknown[]).map((s) => (s as { kind: string }).kind)).toEqual([
        'keypad',
        'lcd'
      ])
      expect((state.portB as unknown[]).map((s) => (s as { kind: string }).kind)).toEqual(['lcd'])
    })

    it('round-trips a key that was pressed but not yet read', () => {
      const m = machine()
      // Straight onto the latch with the machine stopped, so the code is still
      // sitting there unserviced when the snapshot is taken — which is exactly
      // the moment a snapshot that dropped it would lose the keystroke.
      m.onKeypadDown(keyForName('7')!.code)
      expect(m.keypad.hasDataReady()).toBe(true)

      const restored = machine()
      expect(restored.keypad.hasDataReady()).toBe(false)

      restoreSnapshot(restored, wire(captureSnapshot(m)))

      expect(restored.keypad.hasDataReady()).toBe(true)
      expect(restored.keypad.getCurrentKey()).toBe(keyForName('7')!.code)
    })

    it('round-trips what is on the glass', () => {
      const m = machine()
      m.runCycles(2_500_000)
      const shown = [m.lcd.getRowText(0), m.lcd.getRowText(1)]
      expect(shown.join('').trim()).not.toBe('')

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(m)))

      expect([restored.lcd.getRowText(0), restored.lcd.getRowText(1)]).toEqual(shown)
    })

    /**
     * The pixel buffer is 1,395 bytes of pure derivation — updatePixels() rebuilds
     * it from DDRAM, CGRAM and the flags — so carrying it would only create a
     * second copy that can disagree with the first.
     */
    it('does not carry the pixel buffer', () => {
      const m = machine()
      m.runCycles(2_500_000)
      m.lcd.updatePixels()

      const lcd = (captureSnapshot(m).pia.portB as { buffer?: unknown }[])[0]!
      expect(lcd.buffer).toBeUndefined()
    })

    it('rebuilds the same pixels after a restore', () => {
      const m = machine()
      m.runCycles(2_500_000)
      m.lcd.updatePixels()

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(m)))
      restored.lcd.updatePixels()

      expect(Array.from(restored.lcd.buffer)).toEqual(Array.from(m.lcd.buffer))
    })
  })

  describe('determinism', () => {
    /**
     * The property the whole feature rests on: restoring and running is the same
     * as never having stopped. If it does not hold, an agent's test results
     * depend on whether a snapshot happened to be taken, which is worse than no
     * snapshots at all.
     */
    it('a restored machine runs to the same state as one that kept going', () => {
      const original = machine()
      original.runCycles(600_000)

      const snapshot = wire(captureSnapshot(original))

      const restored = machine()
      restoreSnapshot(restored, snapshot)

      original.runCycles(250_000)
      restored.runCycles(250_000)

      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
      expect(restored.ram.serialize()).toEqual(original.ram.serialize())
      expect(restored.pia.serialize()).toEqual(original.pia.serialize())
      for (let slot = 0; slot < 8; slot++) {
        expect(restored.slots()[slot]!.serialize()).toEqual(original.slots()[slot]!.serialize())
      }
    })

    it('resumes mid-instruction rather than re-decoding from the PC', () => {
      const original = machine()
      original.runCycles(600_000)
      // Land part-way through an instruction, which is where a snapshot that
      // stored only the programmer's model would diverge.
      while (original.cpu.cyclesRem === 0) original.tick()
      expect(original.cpu.cyclesRem).toBeGreaterThan(0)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(original)))
      expect(restored.cpu.cyclesRem).toBe(original.cpu.cyclesRem)

      original.runCycles(50_000)
      restored.runCycles(50_000)
      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
    })

    /**
     * A machine parked in WAI looks identical to a running one in every field
     * the programmer's model has — same PC, same registers, cyclesRem zero. The
     * halt lives only in the two flags, so leaving them out of the snapshot
     * would restore a sleeping machine as one that carries straight on
     * executing whatever follows the WAI.
     */
    it('a machine halted in WAI restores still halted', () => {
      const original = machine()
      original.poke(0x0200, 0xcb)  // WAI
      original.poke(0x0201, 0xe8)  // INX, if it ever wakes
      original.cpu.pc = 0x0200
      original.cpu.cyclesRem = 0
      original.runCycles(10)
      expect(original.cpu.waiting).toBe(true)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(original)))

      expect(restored.cpu.waiting).toBe(true)
      expect(restored.cpu.pc).toBe(0x0201)

      original.runCycles(500)
      restored.runCycles(500)
      expect(restored.cpu.serialize()).toEqual(original.cpu.serialize())
    })

    it('a snapshot without the halt flags restores as a running machine', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = wire(captureSnapshot(m))

      // What every snapshot written before WAI and STP halted anything looks
      // like. A missing field is an older format, not corruption.
      delete (snapshot.cpu as Record<string, unknown>).waiting
      delete (snapshot.cpu as Record<string, unknown>).stopped

      const restored = machine()
      restoreSnapshot(restored, snapshot)

      expect(restored.cpu.waiting).toBe(false)
      expect(restored.cpu.stopped).toBe(false)
    })

    it('leaves the cycle counter alone, so elapsed time keeps moving forward', () => {
      const m = machine()
      m.runCycles(1000)
      const snapshot = captureSnapshot(m)
      expect(snapshot.cycles).toBe(m.cycles)

      m.runCycles(1000)
      const before = m.cycles
      restoreSnapshot(m, snapshot)

      expect(m.cycles).toBe(before)
    })
  })

  describe('the Serial Card', () => {
    it('round-trips the ACIA mid-transmission', () => {
      const m = machine()
      const acia = m.io5 as ACIA
      acia.write(0x00, 0x41)

      const restored = machine()
      restoreSnapshot(restored, wire(captureSnapshot(m)))

      expect((restored.io5 as ACIA).serialize()).toEqual(acia.serialize())
    })
  })

  describe('through a Session', () => {
    it('stops the machine, restores, and resumes in the mode it found', () => {
      const session = new Session()
      session.machine.loadROM(BIOS)
      session.machine.loadCardROM(KC_MONITOR)
      session.reset(true)
      session.runCycles(200_000)

      const snapshot = wire(captureSnapshot(session.machine))
      session.runCycles(200_000)

      session.run('turbo')
      expect(session.isRunning).toBe(true)

      session.loadState(() => restoreSnapshot(session.machine, snapshot))

      expect(session.isRunning).toBe(true)
      expect(session.mode).toBe('turbo')
      session.pause()
    })

    it('leaves a paused machine paused', () => {
      const session = new Session()
      session.machine.loadROM(BIOS)
      session.machine.loadCardROM(KC_MONITOR)
      session.reset(true)

      const snapshot = wire(captureSnapshot(session.machine))
      session.loadState(() => restoreSnapshot(session.machine, snapshot))

      expect(session.isRunning).toBe(false)
      expect(session.mode).toBe('paused')
    })
  })
})
