import {
  CIRCUITS,
  IO6_WINDOW,
  circuitFor,
  circuitOf,
  createCircuit
} from '../../core/breadboard/registry'
import { LEDLatch } from '../../core/breadboard/LEDLatch'
import { Empty } from '../../core/IO/Empty'

describe('the circuit registry', () => {

  it('lists the KIM Demo', () => {
    expect(CIRCUITS.map((a) => a.id)).toEqual(['led-latch'])
  })

  it('gives every breadboard a name, a description and a component', () => {
    for (const breadboard of CIRCUITS) {
      expect(breadboard.name).not.toBe('')
      expect(breadboard.description).not.toBe('')
      expect(breadboard.component).not.toBe('')
    }
  })

  it('puts them all on io6', () => {
    expect(IO6_WINDOW).toEqual({ start: 0x9400, end: 0x97ff })
    for (const breadboard of CIRCUITS) {
      expect(breadboard.window).toEqual(IO6_WINDOW)
    }
  })

  /**
   * The id and the card's `IO.kind` are one string. The slot-layout check in
   * Snapshot.ts compares kinds, so this is what makes a snapshot taken with the
   * LEDs fitted refuse to restore into an empty breadboard — with no circuit-specific
   * code in the snapshot at all.
   */
  it('names each card with the id it is registered under', () => {
    for (const breadboard of CIRCUITS) {
      expect(breadboard.create().kind).toBe(breadboard.id)
    }
  })

  it('builds a fresh card each time, so a rebuild starts dark', () => {
    const first = createCircuit('led-latch') as LEDLatch
    first.write(0x000, 0xff)

    const second = createCircuit('led-latch') as LEDLatch
    expect(second).not.toBe(first)
    expect(second.byte).toBe(0x00)
  })

  describe('an id that names nothing', () => {
    /** An empty breadboard is what a KIM is with no breadboard plugged into it. */
    it('leaves the breadboard empty for null', () => {
      expect(circuitFor(null)).toBeUndefined()
      expect(createCircuit(null)).toBeUndefined()
    })

    /**
     * A settings file written by a later build should leave the breadboard empty and
     * boot, rather than refuse to open a window.
     */
    it('leaves the breadboard empty for an id this build has never heard of', () => {
      expect(circuitFor('seven-segment')).toBeUndefined()
      expect(createCircuit('seven-segment')).toBeUndefined()
    })
  })

  describe('describing what is on the bus', () => {
    it('finds the definition for a card that is fitted', () => {
      expect(circuitOf(new LEDLatch())?.name).toBe('KIM Demo — 8 LEDs')
    })

    it('describes an empty slot as nothing at all', () => {
      expect(circuitOf(new Empty())).toBeUndefined()
      expect(circuitOf(null)).toBeUndefined()
    })
  })

})
