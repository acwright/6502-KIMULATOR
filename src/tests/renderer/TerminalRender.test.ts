import {
  CHARACTER_ROM,
  GLYPH_HEIGHT,
  GLYPH_ROWS,
  GLYPH_WIDTH,
  glyphRow
} from '../../renderer/src/terminal/font'
import {
  BACKGROUND,
  FOREGROUND,
  ORIGIN_X,
  ORIGIN_Y,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TEXT_HEIGHT,
  TEXT_WIDTH,
  drawScreen,
  pack
} from '../../renderer/src/terminal/render'
import { TERMINAL_COLS, TERMINAL_ROWS } from '../../renderer/src/terminal/TerminalBuffer'

/**
 * The terminal's picture, checked without a window.
 *
 * The point of drawing the panel into a pixel buffer rather than straight onto a
 * canvas: the raster is fixed, the glyphs come out of the ACE's character
 * generator, and both can be read back a pixel at a time.
 */

/** The screen as `drawScreen` writes it, plus a reader for one pixel. */
const render = (rows: string[], cursor: { row: number; column: number } | null = null) => {
  const pixels = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT)
  drawScreen(pixels, rows, cursor)
  return {
    pixels,
    at: (x: number, y: number) => pixels[y * SCREEN_WIDTH + x]
  }
}

/** A screen of blanks, with `text` written across the top row. */
const screenOf = (text = ''): string[] => {
  const blank = ' '.repeat(TERMINAL_COLS)
  const rows = new Array<string>(TERMINAL_ROWS).fill(blank)
  rows[0] = (text + blank).slice(0, TERMINAL_COLS)
  return rows
}

/** Every cell filled with the same character. */
const screenFilled = (character: string): string[] =>
  new Array<string>(TERMINAL_ROWS).fill(character.repeat(TERMINAL_COLS))

const INK = pack(FOREGROUND)
const PAPER = pack(BACKGROUND)

describe('character generator', () => {
  it('holds all 256 CP437 glyphs, eight rows each', () => {
    expect(CHARACTER_ROM).toHaveLength(256 * GLYPH_ROWS)
  })

  // Why the cell is six pixels wide and not five or eight: nothing in the table
  // reaches past bit 2, the glyphs that reach that far are the ones whose lines
  // have to meet the next cell along, and the text the panel actually draws
  // stops short of it — so every character keeps its gap.
  it('is drawn for a six-pixel cell', () => {
    for (const row of CHARACTER_ROM) expect(row & 0b11).toBe(0)

    const reaches = (code: number): boolean => {
      for (let row = 0; row < GLYPH_ROWS; row++) if (glyphRow(code, row) & 0b100) return true
      return false
    }

    for (let code = 0x20; code <= 0x7e; code++) expect(reaches(code)).toBe(false)
    // The box-drawing half of CP437, which joins up.
    expect(reaches(0xc4)).toBe(true)
  })

  it('draws an A the way the BIOS does', () => {
    const shape = []
    for (let y = 0; y < GLYPH_ROWS; y++) {
      const bits = glyphRow(0x41, y)
      let line = ''
      for (let x = 0; x < GLYPH_WIDTH; x++) line += bits & (0x80 >> x) ? '#' : '.'
      shape.push(line)
    }

    expect(shape).toEqual([
      '.###..',
      '#...#.',
      '#...#.',
      '#...#.',
      '#####.',
      '#...#.',
      '#...#.',
      '......'
    ])
  })

  it('draws blank for a code outside the table', () => {
    expect(glyphRow(-1, 0)).toBe(0)
    expect(glyphRow(256, 0)).toBe(0)
    expect(glyphRow(0x41, GLYPH_ROWS)).toBe(0)
  })

  it('has a blank space, so a blank screen is blank', () => {
    for (let y = 0; y < GLYPH_ROWS; y++) expect(glyphRow(0x20, y)).toBe(0)
  })
})

describe('screen', () => {
  it('is a 320 x 240 raster with the characters centred in it', () => {
    expect(TEXT_WIDTH).toBe(TERMINAL_COLS * GLYPH_WIDTH)
    expect(TEXT_HEIGHT).toBe(TERMINAL_ROWS * GLYPH_HEIGHT)
    // The overscan: the raster is wider and taller than the text it carries.
    expect(ORIGIN_X).toBe(40)
    expect(ORIGIN_Y).toBe(24)
    expect(SCREEN_WIDTH - TEXT_WIDTH).toBe(ORIGIN_X * 2)
    expect(SCREEN_HEIGHT - TEXT_HEIGHT).toBe(ORIGIN_Y * 2)
  })

  it('leaves a blank screen dark, overscan and all', () => {
    const { pixels } = render(screenOf())
    expect(pixels.every((word) => word === PAPER)).toBe(true)
  })

  it('never draws outside the character area', () => {
    // A full screen of the densest printable glyph, and a cursor in the corner.
    const { at } = render(screenFilled('W'), { row: TERMINAL_ROWS - 1, column: TERMINAL_COLS - 1 })

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      expect(at(x, ORIGIN_Y - 1)).toBe(PAPER)
      expect(at(x, SCREEN_HEIGHT - 1)).toBe(PAPER)
    }
    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      expect(at(ORIGIN_X - 1, y)).toBe(PAPER)
      expect(at(SCREEN_WIDTH - 1, y)).toBe(PAPER)
    }
  })

  it('puts a glyph in its cell, in the terminal colours', () => {
    const { at } = render(screenOf('A'))

    // Row 4 of an A is its crossbar: five lit pixels and then the gap column.
    const y = ORIGIN_Y + 4
    for (let x = 0; x < 5; x++) expect(at(ORIGIN_X + x, y)).toBe(INK)
    expect(at(ORIGIN_X + 5, y)).toBe(PAPER)

    // And the second character starts one cell along, not one glyph along.
    expect(at(ORIGIN_X + GLYPH_WIDTH, y)).toBe(PAPER)
  })

  it('draws the cursor as a filled cell with the character knocked out of it', () => {
    const { at } = render(screenOf('A'), { row: 0, column: 0 })

    const y = ORIGIN_Y + 4
    // Inverted: the crossbar is now dark against a lit cell.
    for (let x = 0; x < 5; x++) expect(at(ORIGIN_X + x, y)).toBe(PAPER)
    expect(at(ORIGIN_X + 5, y)).toBe(INK)
    // The whole cell is filled, including the row the glyph leaves empty.
    for (let x = 0; x < GLYPH_WIDTH; x++) {
      expect(at(ORIGIN_X + x, ORIGIN_Y + GLYPH_HEIGHT - 1)).toBe(INK)
    }
  })

  it('draws nothing extra when the panel does not hold the keyboard', () => {
    const { pixels } = render(screenOf(), null)
    expect(pixels.every((word) => word === PAPER)).toBe(true)
  })

  it('treats a short row as blanks rather than drawing rubbish', () => {
    const rows = new Array<string>(TERMINAL_ROWS).fill('')
    const { pixels } = render(rows)
    expect(pixels.every((word) => word === PAPER)).toBe(true)
  })
})
