import { LEDLatch } from '@core/accessories/LEDLatch'

/**
 * How a latched byte reads as eight lamps.
 *
 * Kept out of `LEDLatchView.vue` for the usual reason — it can be checked
 * without a browser — but also because this is the one thing about the panel
 * that can be *wrong* rather than ugly: the DOCS cards say "bit 0 (value $01) is
 * the rightmost LED; bit 7 (value $80) is the leftmost", and a view that drew
 * them the other way round would make both type-in programs look like they were
 * running backwards while behaving perfectly.
 */

export interface Lamp {
  /** Which bit of the latch drives it. 7 is the leftmost lamp, 0 the rightmost. */
  bit: number

  /** Its place value — `$80` down to `$01`, which is what the cards talk in. */
  mask: number

  lit: boolean
}

/** The eight lamps, left to right, as the byte on the latch lights them. */
export function lamps(byte: number): Lamp[] {
  const value = byte & 0xff
  return Array.from({ length: LEDLatch.LAMPS }, (_, index) => {
    const bit = LEDLatch.LAMPS - 1 - index
    const mask = 1 << bit
    return { bit, mask, lit: (value & mask) !== 0 }
  })
}

/** The byte beneath the lamps, as the monitor and the cards write it. */
export function readout(byte: number): string {
  return `$${(byte & 0xff).toString(16).toUpperCase().padStart(2, '0')}`
}
