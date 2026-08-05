/**
 * The table checked against the table.
 *
 * `EXPECTED` below is a second, independent transcription of 6502-DOCS
 * `docs/reference/keypad-map.md` — every code, the key it names, the character
 * the monitor echoes for it, and the hexadecimal value it carries. Transcribing
 * it twice is the whole point: KeypadMap is the one place the pad is described,
 * so the only thing that can catch a typo in it is another reading of the
 * source, and a test that imported the map and compared it to itself would pass
 * whatever the map said.
 *
 * The values were also read against the KC Monitor's own `KeySymTable` and
 * `KeyToHex` in 6502-KIM `Firmware/KC Monitor/KC Monitor.asm`.
 */
import {
  KEYPAD,
  KEYPAD_COLS,
  KEYPAD_ROWS,
  KEY_COUNT,
  keyForCode,
  keyForHostCode,
  keyForName,
  keyNames
} from '../core/KeypadMap'

/** code, label, LCD glyph, hex value (null where the key is a command). */
const EXPECTED: ReadonlyArray<readonly [number, string, string, number | null]> = [
  [0x00, '◄',    '<', null],
  [0x01, '1',    '1', 1],
  [0x02, '2',    '2', 2],
  [0x03, '3',    '3', 3],
  [0x04, '4',    '4', 4],
  [0x05, '5',    '5', 5],
  [0x06, '6',    '6', 6],
  [0x07, '7',    '7', 7],
  [0x08, '8',    '8', 8],
  [0x09, '9',    '9', 9],
  [0x0A, '0',    '0', 0],
  [0x0B, '►',    '>', null],
  [0x0C, 'F',    'F', 15],
  [0x0D, 'E',    'E', 14],
  [0x0E, 'D',    'D', 13],
  [0x0F, 'C',    'C', 12],
  [0x10, 'ESC',  '*', null],
  [0x11, 'INS',  'I', null],
  [0x12, 'PGUP', 'U', null],
  [0x13, 'A',    'A', 10],
  [0x14, '▲',    '^', null],
  [0x15, 'DEL',  'X', null],
  [0x16, 'PGDN', 'N', null],
  [0x17, 'B',    'B', 11]
]

/** The pad as it physically sits, read left to right and top to bottom. */
const LAYOUT: ReadonlyArray<readonly string[]> = [
  ['ESC', 'INS', 'PGUP', 'A'],
  ['▲',   'DEL', 'PGDN', 'B'],
  ['7',   '8',   '9',    'C'],
  ['4',   '5',   '6',    'D'],
  ['1',   '2',   '3',    'E'],
  ['◄',   '0',   '►',    'F']
]

describe('KeypadMap', () => {
  describe('the table', () => {
    it('has all twenty-four keys and no more', () => {
      expect(KEYPAD).toHaveLength(KEY_COUNT)
      expect(KEY_COUNT).toBe(24)
      expect(KEYPAD_COLS * KEYPAD_ROWS).toBe(KEY_COUNT)
    })

    it('uses each encoder code exactly once, covering $00–$17', () => {
      const codes = KEYPAD.map((key) => key.code).sort((a, b) => a - b)
      expect(codes).toEqual([...Array(KEY_COUNT).keys()])
    })

    it('puts one key in each of the twenty-four grid positions', () => {
      const positions = KEYPAD.map((key) => `${key.row},${key.col}`)
      expect(new Set(positions).size).toBe(KEY_COUNT)
      for (const key of KEYPAD) {
        expect(key.row).toBeGreaterThanOrEqual(0)
        expect(key.row).toBeLessThan(KEYPAD_ROWS)
        expect(key.col).toBeGreaterThanOrEqual(0)
        expect(key.col).toBeLessThan(KEYPAD_COLS)
      }
    })

    it('gives no two keys the same label', () => {
      expect(new Set(KEYPAD.map((key) => key.label)).size).toBe(KEY_COUNT)
    })

    it('claims no host key twice', () => {
      const hosts = KEYPAD.flatMap((key) => key.keys)
      expect(new Set(hosts).size).toBe(hosts.length)
    })
  })

  describe('every code, against the reference', () => {
    it.each(EXPECTED)('$%s is the key described in the keypad map', (code, label, glyph, value) => {
      const key = keyForCode(code)
      expect(key).toBeDefined()
      expect(key!.label).toBe(label)
      expect(key!.glyph).toBe(glyph)
      expect(key!.value).toBe(value ?? undefined)
    })

    it('has nothing at a code the encoder cannot produce', () => {
      for (const code of [-1, 0x18, 0x1f, 0x20, 0xff]) {
        expect(keyForCode(code)).toBeUndefined()
      }
    })
  })

  /**
   * The trap this exists for. They line up for `1` to `9` and nowhere else: key
   * `0` is code $0A, and `C` to `F` run backwards. Anything that derives a value
   * from a code arithmetically is wrong, and this is where that shows up.
   */
  describe('the code is not the value', () => {
    it('reads key 0 at code $0A', () => {
      expect(keyForCode(0x0a)!.label).toBe('0')
      expect(keyForCode(0x0a)!.value).toBe(0x00)
    })

    it('runs C to F backwards', () => {
      expect(keyForCode(0x0c)!.label).toBe('F')
      expect(keyForCode(0x0d)!.label).toBe('E')
      expect(keyForCode(0x0e)!.label).toBe('D')
      expect(keyForCode(0x0f)!.label).toBe('C')
    })

    it('agrees with the code only for 1 to 9', () => {
      const agreeing = KEYPAD.filter((key) => key.value === key.code).map((key) => key.label)
      expect(agreeing.sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    })

    it('puts A to F where the monitor expects them', () => {
      for (const [label, value] of [['A', 10], ['B', 11], ['C', 12], ['D', 13], ['E', 14], ['F', 15]] as const) {
        expect(KEYPAD.find((key) => key.label === label)!.value).toBe(value)
      }
    })
  })

  describe('the grid', () => {
    it('lays the pad out as the real one is legended', () => {
      const drawn = Array.from({ length: KEYPAD_ROWS }, () => new Array<string>(KEYPAD_COLS))
      for (const key of KEYPAD) drawn[key.row][key.col] = key.label
      expect(drawn).toEqual(LAYOUT.map((row) => [...row]))
    })

    it('makes the sixteen hex keys exactly the ones with a value', () => {
      const withValue = KEYPAD.filter((key) => key.value !== undefined)
      expect(withValue).toHaveLength(16)
      expect(withValue.map((key) => key.label).sort()).toEqual(
        ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F']
      )
    })

    it('leaves the eight command keys without one', () => {
      const withoutValue = KEYPAD.filter((key) => key.value === undefined).map((key) => key.label)
      expect(new Set(withoutValue)).toEqual(
        new Set(['DEL', 'ESC', 'INS', 'PGDN', 'PGUP', '◄', '►', '▲'])
      )
    })
  })

  describe('keyForHostCode', () => {
    it.each([
      ['Escape', 0x10],
      ['Insert', 0x11],
      ['PageUp', 0x12],
      ['PageDown', 0x16],
      ['Delete', 0x15],
      ['ArrowLeft', 0x00],
      ['ArrowRight', 0x0b],
      ['ArrowUp', 0x14],
      ['Enter', 0x14],
      ['NumpadEnter', 0x14],
      ['KeyA', 0x13],
      ['KeyF', 0x0c],
      ['Digit0', 0x0a],
      ['Numpad0', 0x0a],
      ['Digit7', 0x07],
      ['Numpad7', 0x07]
    ])('presses %s', (host, code) => {
      expect(keyForHostCode(host as string)!.code).toBe(code)
    })

    it('reaches a digit from the number row and the numeric pad alike', () => {
      for (let digit = 0; digit <= 9; digit++) {
        expect(keyForHostCode(`Digit${digit}`)).toBe(keyForHostCode(`Numpad${digit}`))
      }
    })

    /**
     * Enter is ▲, which runs the program at the current address. That is the
     * KC Monitor's choice and not a convenience: there is no separate Enter key
     * on the pad for it to be confused with.
     */
    it('sends Enter to ▲, the key that runs a program', () => {
      expect(keyForHostCode('Enter')!.label).toBe('▲')
    })

    it('leaves keys that are not on the pad alone', () => {
      // ArrowDown especially: three arrows are legended, and down is not one.
      for (const host of ['ArrowDown', 'KeyG', 'KeyZ', 'Space', 'Tab', 'Backspace', 'F1', '']) {
        expect(keyForHostCode(host)).toBeUndefined()
      }
    })
  })

  describe('keyForName', () => {
    it('finds a key by its legend', () => {
      expect(keyForName('ESC')!.code).toBe(0x10)
      expect(keyForName('PGDN')!.code).toBe(0x16)
      expect(keyForName('7')!.code).toBe(0x07)
    })

    it('is case-insensitive and forgives whitespace', () => {
      expect(keyForName('esc')!.code).toBe(0x10)
      expect(keyForName('  PgUp  ')!.code).toBe(0x12)
    })

    it('takes a word for the keys legended with a glyph', () => {
      expect(keyForName('left')!.code).toBe(0x00)
      expect(keyForName('right')!.code).toBe(0x0b)
      expect(keyForName('up')!.code).toBe(0x14)
      expect(keyForName('enter')!.code).toBe(0x14)
      expect(keyForName('run')!.code).toBe(0x14)
    })

    it('still answers to the glyph itself', () => {
      expect(keyForName('◄')!.code).toBe(0x00)
      expect(keyForName('▲')!.code).toBe(0x14)
    })

    it('returns nothing for a name that is not a key', () => {
      for (const name of ['', 'G', 'SHIFT', 'DOWN', 'PGMIDDLE']) {
        expect(keyForName(name)).toBeUndefined()
      }
    })

    it('accepts every name it advertises', () => {
      const names = keyNames()
      expect(names.length).toBeGreaterThan(KEY_COUNT)
      for (const name of names) {
        expect(keyForName(name)).toBeDefined()
      }
    })
  })
})
