import { LEDLatch } from '../../core/accessories/LEDLatch'
import { StateError } from '../../core/DeviceState'
import { Machine } from '../../core/Machine'

describe('LEDLatch', () => {

  describe('latching', () => {
    it('holds the byte that was written', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0xaa)
      expect(latch.byte).toBe(0xaa)
    })

    it('keeps only the low eight bits — a 373 has eight of them', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0x1ff)
      expect(latch.byte).toBe(0xff)
    })

    /**
     * LE is gated from the slot select and R/W; no address line below A10
     * reaches the card, so every byte of the window is the same register. This
     * is what makes `ProbeGPIO`'s write to $9402 land on the lamps.
     */
    it('latches from anywhere in the window', () => {
      const latch = new LEDLatch()
      for (const offset of [0x000, 0x002, 0x00f, 0x100, 0x3ff]) {
        latch.write(offset, offset & 0xff)
        expect(latch.byte).toBe(offset & 0xff)
      }
    })

    it('lights bit 7 leftmost and bit 0 rightmost', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0b1000_0001)
      expect(latch.lit(7)).toBe(true)
      expect(latch.lit(0)).toBe(true)
      for (const bit of [1, 2, 3, 4, 5, 6]) expect(latch.lit(bit)).toBe(false)
    })
  })

  /**
   * The reason the card exists in this shape. A read-back would pass the BIOS's
   * DDR test and set HW_GPIO on a machine with no VIA in it — see the
   * integration test in LEDDemo.test.ts, which checks the firmware agrees.
   */
  describe('reads', () => {
    it('returns open bus, not the latched byte', () => {
      const latch = new LEDLatch()
      latch.write(0x002, 0xaa)
      expect(latch.read(0x002)).toBe(0)
      expect(latch.read(0x000)).toBe(0)
    })
  })

  describe('reset', () => {
    /** A 74HC373 has no clear pin, so RESET cannot empty it — and does not. */
    it('holds its byte across a warm reset', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0x5a)
      latch.reset(false)
      expect(latch.byte).toBe(0x5a)
    })

    it('goes dark on a cold start', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0x5a)
      latch.reset(true)
      expect(latch.byte).toBe(0x00)
    })
  })

  describe('state', () => {
    it('round-trips the latched byte', () => {
      const latch = new LEDLatch()
      latch.write(0x000, 0xc3)

      const restored = new LEDLatch()
      restored.deserialize(latch.serialize())

      expect(restored.byte).toBe(0xc3)
    })

    it("refuses another card's state", () => {
      expect(() => new LEDLatch().deserialize({ kind: 'acia' })).toThrow(StateError)
    })

    it('refuses a state with no latched byte in it', () => {
      expect(() => new LEDLatch().deserialize({ kind: LEDLatch.ID })).toThrow(StateError)
    })
  })

  /**
   * On the bus rather than in isolation: io6 is decoded at $9400-$97FF, and the
   * accessory is the only card on a KIM that a program is expected to write to
   * directly.
   */
  describe('on the bus', () => {
    it('answers the whole io6 window and reads back as open bus', () => {
      const latch = new LEDLatch()
      const machine = new Machine({ io6: latch })

      machine.poke(0x9400, 0x81)
      expect(latch.byte).toBe(0x81)
      expect(machine.peek(0x9400)).toBe(0)

      machine.poke(0x97ff, 0x18)
      expect(latch.byte).toBe(0x18)
    })

    it('is not touched by a write to the slot next door', () => {
      const latch = new LEDLatch()
      const machine = new Machine({ io6: latch })

      machine.poke(0x93ff, 0xff)   // io5, the Serial Card's window
      machine.poke(0x9800, 0xff)   // io7
      expect(latch.byte).toBe(0x00)
    })
  })

})
