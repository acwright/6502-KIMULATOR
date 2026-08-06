import {
  ACCESSORIES,
  ACCESSORY_WINDOW,
  accessoryFor,
  accessoryOf,
  createAccessory
} from '../../core/accessories/registry'
import { LEDLatch } from '../../core/accessories/LEDLatch'
import { Empty } from '../../core/IO/Empty'

describe('the accessory registry', () => {

  it('lists the KIM Demo', () => {
    expect(ACCESSORIES.map((a) => a.id)).toEqual(['led-latch'])
  })

  it('gives every accessory a name, a description and a component', () => {
    for (const accessory of ACCESSORIES) {
      expect(accessory.name).not.toBe('')
      expect(accessory.description).not.toBe('')
      expect(accessory.component).not.toBe('')
    }
  })

  it('puts them all on io6', () => {
    expect(ACCESSORY_WINDOW).toEqual({ start: 0x9400, end: 0x97ff })
    for (const accessory of ACCESSORIES) {
      expect(accessory.window).toEqual(ACCESSORY_WINDOW)
    }
  })

  /**
   * The id and the card's `IO.kind` are one string. The slot-layout check in
   * Snapshot.ts compares kinds, so this is what makes a snapshot taken with the
   * LEDs fitted refuse to restore into an empty bay — with no accessory-specific
   * code in the snapshot at all.
   */
  it('names each card with the id it is registered under', () => {
    for (const accessory of ACCESSORIES) {
      expect(accessory.create().kind).toBe(accessory.id)
    }
  })

  it('builds a fresh card each time, so a rebuild starts dark', () => {
    const first = createAccessory('led-latch') as LEDLatch
    first.write(0x000, 0xff)

    const second = createAccessory('led-latch') as LEDLatch
    expect(second).not.toBe(first)
    expect(second.byte).toBe(0x00)
  })

  describe('an id that names nothing', () => {
    /** An empty bay is what a KIM is with no breadboard plugged into it. */
    it('leaves the bay empty for null', () => {
      expect(accessoryFor(null)).toBeUndefined()
      expect(createAccessory(null)).toBeUndefined()
    })

    /**
     * A settings file written by a later build should leave the bay empty and
     * boot, rather than refuse to open a window.
     */
    it('leaves the bay empty for an id this build has never heard of', () => {
      expect(accessoryFor('seven-segment')).toBeUndefined()
      expect(createAccessory('seven-segment')).toBeUndefined()
    })
  })

  describe('describing what is on the bus', () => {
    it('finds the definition for a card that is fitted', () => {
      expect(accessoryOf(new LEDLatch())?.name).toBe('KIM Demo — 8 LEDs')
    })

    it('describes an empty slot as nothing at all', () => {
      expect(accessoryOf(new Empty())).toBeUndefined()
      expect(accessoryOf(null)).toBeUndefined()
    })
  })

})
