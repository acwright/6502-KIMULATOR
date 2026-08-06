/**
 * How the terminal is drawn.
 *
 * Kept out of `Terminal.vue` for the same reason the LCD's drawing is kept out
 * of `LCDPanel.vue`: it is arithmetic over a pixel buffer, it has a right
 * answer, and it can be checked without a window.
 *
 * **The screen is a fixed 320 × 240 picture.** Nothing here scales with the
 * window. The 40 × 24 character area is 240 × 192 of it, drawn in the ACE's own
 * 6 × 8 cell out of the ACE's own character generator (see `font.ts`), and the
 * 40 columns and 24 rows left over are overscan — the part of a CRT's raster
 * that falls outside the picture the tube was set up to show. The panel then
 * scales that picture up to whatever room it has, whole pixels and all, exactly
 * as 6502-EMULATOR scales its 320 × 240 video buffer. A terminal that instead
 * picked a font size off the window would be a text box, and would look like
 * one.
 */
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphRow } from './font'
import { TERMINAL_COLS, TERMINAL_ROWS } from './TerminalBuffer'

/** The raster, in pixels. The ACE's video buffer, and a CRT's 4:3. */
export const SCREEN_WIDTH = 320
export const SCREEN_HEIGHT = 240

/** The character area: 40 × 24 cells of 6 × 8. */
export const TEXT_WIDTH = TERMINAL_COLS * GLYPH_WIDTH
export const TEXT_HEIGHT = TERMINAL_ROWS * GLYPH_HEIGHT

/** Where the character area starts — the overscan is what is left around it. */
export const ORIGIN_X = (SCREEN_WIDTH - TEXT_WIDTH) / 2
export const ORIGIN_Y = (SCREEN_HEIGHT - TEXT_HEIGHT) / 2

/** Phosphor white, and the dark the tube sits at. Both fill the whole raster. */
export const FOREGROUND: RGB = [232, 232, 232]
export const BACKGROUND: RGB = [0, 0, 0]

export type RGB = readonly [number, number, number]

/**
 * A colour as one word in the layout `ImageData` uses.
 *
 * `ImageData` is bytes in RGBA order, so the word a `Uint32Array` view over it
 * needs depends on the machine. Probed once rather than assumed: every platform
 * this runs on today is little-endian, and silently drawing in BGR on the one
 * that is not would be a strange bug to go looking for.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

export function pack([r, g, b]: RGB): number {
  const word = LITTLE_ENDIAN
    ? (255 << 24) | (b << 16) | (g << 8) | r
    : (r << 24) | (g << 16) | (b << 8) | 255
  return word >>> 0
}

/**
 * Draw the screen into `pixels`, a `SCREEN_WIDTH * SCREEN_HEIGHT` word buffer —
 * a `Uint32Array` view over an `ImageData`'s bytes.
 *
 * `rows` is the visible screen, one string per row, as `TerminalBuffer.screen()`
 * returns it. `cursor` is drawn as a filled cell with the character knocked back
 * out of it, and is null when the panel does not hold the keyboard: a cursor on
 * a terminal that will not receive the next key is claiming something untrue.
 */
export function drawScreen(
  pixels: Uint32Array,
  rows: readonly string[],
  cursor: { row: number; column: number } | null
): void {
  const foreground = pack(FOREGROUND)
  const background = pack(BACKGROUND)

  // The overscan is the same dark as the screen, so this fills both.
  pixels.fill(background)

  for (let row = 0; row < TERMINAL_ROWS; row++) {
    const text = rows[row] ?? ''
    for (let column = 0; column < TERMINAL_COLS; column++) {
      const inverse = cursor !== null && cursor.row === row && cursor.column === column
      const code = text.charCodeAt(column)
      drawCell(
        pixels,
        Number.isNaN(code) ? 0x20 : code,
        column,
        row,
        inverse ? background : foreground,
        inverse ? foreground : background
      )
    }
  }
}

/**
 * One character cell.
 *
 * The cell is filled before the glyph goes in rather than only where the glyph
 * is, which is what makes the cursor a solid block with a hole in the shape of
 * the character under it.
 */
function drawCell(
  pixels: Uint32Array,
  code: number,
  column: number,
  row: number,
  ink: number,
  paper: number
): void {
  const left = ORIGIN_X + column * GLYPH_WIDTH
  const top = ORIGIN_Y + row * GLYPH_HEIGHT

  for (let y = 0; y < GLYPH_HEIGHT; y++) {
    // Glyphs are eight rows of eight bits; the cell takes the top six, which is
    // the five the BIOS draws plus its built-in gap. See font.ts.
    const bits = glyphRow(code, y)
    let offset = (top + y) * SCREEN_WIDTH + left
    for (let x = 0; x < GLYPH_WIDTH; x++, offset++) {
      pixels[offset] = bits & (0x80 >> x) ? ink : paper
    }
  }
}
