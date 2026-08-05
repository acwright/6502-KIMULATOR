import { CardROM } from '../core/CardROM'
import { ROM } from '../core/ROM'

describe('CardROM', () => {
  let card: CardROM

  beforeEach(() => {
    card = new CardROM()
  })

  describe('geometry', () => {
    it('is an 8 KB AT28C64 at $E000', () => {
      expect(CardROM.START).toBe(0xe000)
      expect(CardROM.END).toBe(0xffff)
      expect(CardROM.SIZE).toBe(8192)
      expect(CardROM.SIZE).toBe(CardROM.END - CardROM.START + 1)
    })

    /**
     * The card overlays the top of the map, so the vectors the CPU fetches are
     * its own and not the BIOS's. They are the last six bytes of the image.
     */
    it('carries the CPU vectors, six bytes from the end', () => {
      expect(CardROM.VECTORS).toBe(0xfffa)
      expect(CardROM.VECTORS - CardROM.START).toBe(0x1ffa)
      expect(CardROM.SIZE - (CardROM.VECTORS - CardROM.START)).toBe(6)
    })

    it('sits entirely inside the BIOS ROM window it overlays', () => {
      expect(CardROM.START).toBeGreaterThan(ROM.START)
      expect(CardROM.END).toBe(ROM.END)
    })
  })

  describe('initialization', () => {
    it('starts as a full-size image of $00', () => {
      expect(card.data).toHaveLength(CardROM.SIZE)
      expect(card.data.every((byte) => byte === 0x00)).toBe(true)
    })
  })

  describe('read()', () => {
    it('reads by offset from START, as the machine addresses it', () => {
      card.data[0x0000] = 0x42
      card.data[0x1fff] = 0xbb
      expect(card.read(0xe000 - CardROM.START)).toBe(0x42)
      expect(card.read(0xffff - CardROM.START)).toBe(0xbb)
    })

    it('reads $00 from an untouched offset', () => {
      expect(card.read(0x1000)).toBe(0x00)
    })

    it('reads the reset vector back out of a loaded image', () => {
      const image = new Array(CardROM.SIZE).fill(0x00)
      image[0x1ffc] = 0x00 // RESET low
      image[0x1ffd] = 0xe0 // RESET high — $E000, the start of the card
      card.load(image)

      const offset = CardROM.VECTORS - CardROM.START
      expect(card.read(offset + 2) | (card.read(offset + 3) << 8)).toBe(0xe000)
    })
  })

  describe('load()', () => {
    it('accepts an 8 KB image', () => {
      const image = new Array(CardROM.SIZE).fill(0xff)
      card.load(image)
      expect(card.data).toBe(image)
      expect(card.read(0)).toBe(0xff)
      expect(card.read(CardROM.SIZE - 1)).toBe(0xff)
    })

    it('replaces the image it already held', () => {
      card.data[0x0100] = 0xaa
      card.load(new Array(CardROM.SIZE).fill(0x55))
      expect(card.read(0x0100)).toBe(0x55)
    })

    /**
     * The mistake this catches is pointing Settings' *Keypad Card ROM* at a
     * BIOS.bin — same folder, four times the size. Refusing it leaves the
     * bundled KC Monitor in place rather than a machine with no vectors.
     */
    it('refuses a 32 KB BIOS image', () => {
      const before = [...card.data]
      card.load(new Array(ROM.SIZE).fill(0xff))
      expect(card.data).toEqual(before)
    })

    it('refuses anything that is not exactly 8 KB', () => {
      for (const size of [0, 1, CardROM.SIZE - 1, CardROM.SIZE + 1, 0x4000]) {
        const before = [...card.data]
        card.load(new Array(size).fill(0xff))
        expect(card.data).toEqual(before)
      }
    })
  })
})
