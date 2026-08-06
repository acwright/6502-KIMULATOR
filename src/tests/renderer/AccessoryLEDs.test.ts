import { lamps, readout } from '../../renderer/src/accessory/leds'

describe('the LED accessory panel', () => {

  /**
   * The one thing about this panel that can be wrong rather than merely ugly.
   * 6502-DOCS' cards say bit 0 (value $01) is the rightmost lamp and bit 7
   * ($80) the leftmost; drawn the other way round, both type-in programs look
   * like they are running backwards while behaving perfectly.
   */
  describe('lamp order', () => {
    it('puts bit 7 leftmost and bit 0 rightmost', () => {
      expect(lamps(0x00).map((lamp) => lamp.bit)).toEqual([7, 6, 5, 4, 3, 2, 1, 0])
    })

    it('gives each lamp its place value', () => {
      expect(lamps(0x00).map((lamp) => lamp.mask))
        .toEqual([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01])
    })

    it('lights the left-hand lamp alone for $80', () => {
      expect(lamps(0x80).map((lamp) => lamp.lit))
        .toEqual([true, false, false, false, false, false, false, false])
    })

    it('lights the right-hand lamp alone for $01', () => {
      expect(lamps(0x01).map((lamp) => lamp.lit))
        .toEqual([false, false, false, false, false, false, false, true])
    })
  })

  describe('lighting', () => {
    it('draws eight lamps whatever the byte', () => {
      for (const byte of [0x00, 0x01, 0xaa, 0xff]) expect(lamps(byte)).toHaveLength(8)
    })

    it('leaves them all dark for $00 and lights them all for $FF', () => {
      expect(lamps(0x00).every((lamp) => !lamp.lit)).toBe(true)
      expect(lamps(0xff).every((lamp) => lamp.lit)).toBe(true)
    })

    /** $AA is what the card suggests storing to see an alternating pattern. */
    it('alternates for $AA', () => {
      expect(lamps(0xaa).map((lamp) => lamp.lit))
        .toEqual([true, false, true, false, true, false, true, false])
    })

    it('ignores anything above the eighth bit', () => {
      expect(lamps(0x1ff)).toEqual(lamps(0xff))
    })
  })

  describe('the readout', () => {
    it('writes the byte as the monitor and the cards do', () => {
      expect(readout(0x00)).toBe('$00')
      expect(readout(0x0a)).toBe('$0A')
      expect(readout(0xff)).toBe('$FF')
    })

    it('shows the low byte of anything wider', () => {
      expect(readout(0x1a5)).toBe('$A5')
    })
  })

})
