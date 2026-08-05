/**
 * The twenty-four keys, in one table.
 *
 * The MM74C922 on the Keypad Helper — sixteen keys natively, extended to
 * twenty-four with a 74HC00 — scans the pad and hands the PIA a five-bit code on
 * PA0–PA4. That code is not the value printed on the key. They line up for `1`
 * to `9` and nowhere else: `0` is $0A, and `C` to `F` run *backwards*, because
 * the encoder numbers the switches in the order they sit on the board.
 *
 * There is no arithmetic that gets you from a code to a digit, only this table.
 * So there is exactly one of it, and the UI, the CLI and the tests all read it —
 * a keypad that disagrees with itself between the panel you click and the
 * `key` command you script is a bug with no single place to fix.
 *
 * Checked against 6502-DOCS `docs/reference/keypad-map.md` and the KC Monitor's
 * own `KeySymTable`.
 */

/** One key on the pad. */
export interface KeypadKey {
  /** The encoder's 5-bit code, $00–$17. This is what reaches the PIA. */
  code: number

  /** What is legended on the keycap. */
  label: string

  /** The character the KC Monitor echoes to the LCD for this key. */
  glyph: string

  /**
   * The hexadecimal value the monitor reads this key as, or undefined for the
   * eight keys that are commands rather than digits.
   *
   * This is also what tells the two kinds of key apart for the panel: the
   * sixteen with a value are black on white, the eight without are white on
   * black, exactly as the real pad is legended.
   */
  value?: number

  /** Where it sits: row 0 at the top, column 0 at the left, 4 × 6. */
  row: number
  col: number

  /**
   * The host `KeyboardEvent.code`s that press this key.
   *
   * `code` rather than `key` so the pad answers to the physical key wherever the
   * layout puts it, and so a digit reaches its keycap from the number row or the
   * numeric keypad alike.
   */
  keys: readonly string[]
}

/** How many keys the encoder can report. Codes $00–$17. */
export const KEY_COUNT = 24

/** The pad's geometry, as the panel lays it out. */
export const KEYPAD_COLS = 4
export const KEYPAD_ROWS = 6

/**
 * The pad as it sits, read left to right and top to bottom.
 *
 *   ESC  INS  PGUP  A
 *    ▲   DEL  PGDN  B
 *    7    8    9    C
 *    4    5    6    D
 *    1    2    3    E
 *    ◄    0    ►    F
 */
export const KEYPAD: readonly KeypadKey[] = [
  { code: 0x10, label: 'ESC',  glyph: '*', row: 0, col: 0, keys: ['Escape'] },
  { code: 0x11, label: 'INS',  glyph: 'I', row: 0, col: 1, keys: ['Insert'] },
  { code: 0x12, label: 'PGUP', glyph: 'U', row: 0, col: 2, keys: ['PageUp'] },
  { code: 0x13, label: 'A',    glyph: 'A', row: 0, col: 3, keys: ['KeyA'], value: 0x0A },

  { code: 0x14, label: '▲',    glyph: '^', row: 1, col: 0, keys: ['ArrowUp', 'Enter', 'NumpadEnter'] },
  { code: 0x15, label: 'DEL',  glyph: 'X', row: 1, col: 1, keys: ['Delete'] },
  { code: 0x16, label: 'PGDN', glyph: 'N', row: 1, col: 2, keys: ['PageDown'] },
  { code: 0x17, label: 'B',    glyph: 'B', row: 1, col: 3, keys: ['KeyB'], value: 0x0B },

  { code: 0x07, label: '7',    glyph: '7', row: 2, col: 0, keys: ['Digit7', 'Numpad7'], value: 0x07 },
  { code: 0x08, label: '8',    glyph: '8', row: 2, col: 1, keys: ['Digit8', 'Numpad8'], value: 0x08 },
  { code: 0x09, label: '9',    glyph: '9', row: 2, col: 2, keys: ['Digit9', 'Numpad9'], value: 0x09 },
  { code: 0x0F, label: 'C',    glyph: 'C', row: 2, col: 3, keys: ['KeyC'], value: 0x0C },

  { code: 0x04, label: '4',    glyph: '4', row: 3, col: 0, keys: ['Digit4', 'Numpad4'], value: 0x04 },
  { code: 0x05, label: '5',    glyph: '5', row: 3, col: 1, keys: ['Digit5', 'Numpad5'], value: 0x05 },
  { code: 0x06, label: '6',    glyph: '6', row: 3, col: 2, keys: ['Digit6', 'Numpad6'], value: 0x06 },
  { code: 0x0E, label: 'D',    glyph: 'D', row: 3, col: 3, keys: ['KeyD'], value: 0x0D },

  { code: 0x01, label: '1',    glyph: '1', row: 4, col: 0, keys: ['Digit1', 'Numpad1'], value: 0x01 },
  { code: 0x02, label: '2',    glyph: '2', row: 4, col: 1, keys: ['Digit2', 'Numpad2'], value: 0x02 },
  { code: 0x03, label: '3',    glyph: '3', row: 4, col: 2, keys: ['Digit3', 'Numpad3'], value: 0x03 },
  { code: 0x0D, label: 'E',    glyph: 'E', row: 4, col: 3, keys: ['KeyE'], value: 0x0E },

  { code: 0x00, label: '◄',    glyph: '<', row: 5, col: 0, keys: ['ArrowLeft'] },
  { code: 0x0A, label: '0',    glyph: '0', row: 5, col: 1, keys: ['Digit0', 'Numpad0'], value: 0x00 },
  { code: 0x0B, label: '►',    glyph: '>', row: 5, col: 2, keys: ['ArrowRight'] },
  { code: 0x0C, label: 'F',    glyph: 'F', row: 5, col: 3, keys: ['KeyF'], value: 0x0F }
]

const BY_CODE = new Map<number, KeypadKey>(KEYPAD.map((key) => [key.code, key]))

const BY_LABEL = new Map<string, KeypadKey>(
  KEYPAD.map((key) => [key.label.toUpperCase(), key])
)

const BY_HOST_KEY = new Map<string, KeypadKey>(
  KEYPAD.flatMap((key) => key.keys.map((host) => [host, key] as const))
)

/** The key an encoder code names, or undefined for a code no switch produces. */
export function keyForCode(code: number): KeypadKey | undefined {
  return BY_CODE.get(code)
}

/**
 * The key a host `KeyboardEvent.code` presses, or undefined when that key is not
 * on the pad — `ArrowDown` and `KeyG` among them. The panel and the focus router
 * both ask this, and both let an unclaimed key fall through to the browser.
 */
export function keyForHostCode(hostCode: string): KeypadKey | undefined {
  return BY_HOST_KEY.get(hostCode)
}

/**
 * The key a name names, for `6502-kim dbg key <name>` and the debug protocol.
 *
 * Case-insensitive, and the four keys legended with a glyph answer to a word as
 * well: `LEFT`, `RIGHT`, `UP` and the `▲` on the cap are the same switch.
 */
export function keyForName(name: string): KeypadKey | undefined {
  const wanted = name.trim().toUpperCase()
  return BY_LABEL.get(wanted) ?? BY_LABEL.get(ALIASES[wanted] ?? '')
}

const ALIASES: Readonly<Record<string, string>> = {
  LEFT: '◄',
  RIGHT: '►',
  UP: '▲',
  ENTER: '▲',
  RUN: '▲'
}

/** Every name `keyForName` accepts, for a usage message that cannot drift. */
export function keyNames(): string[] {
  return [...KEYPAD.map((key) => key.label), ...Object.keys(ALIASES)]
}
