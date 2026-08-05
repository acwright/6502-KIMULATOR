import { KEYPAD, KEYPAD_COLS, KEYPAD_ROWS } from '@core/KeypadMap'
import type { KeypadKey } from '@core/KeypadMap'

/**
 * How the pad is drawn, derived from the one table that describes it.
 *
 * Kept apart from `Keypad.vue` so the wiring between the map and the panel can
 * be checked without a browser: which caps are black on white, which get an
 * arrow instead of a legend, where each one sits, and — the part that actually
 * matters — that the code the cap sends is the code the encoder produces. The
 * component is markup over this and nothing else.
 *
 * Nothing here derives a code from a label or a label from a code. The encoder
 * numbers the switches in the order they sit on the board, so `0` is $0A and
 * `C`–`F` run backwards; a panel that did its own arithmetic would be a second,
 * quietly different description of the pad.
 */

/** The three keys legended with an arrow rather than with text. */
export type Arrow = 'up' | 'left' | 'right'

const ARROWS: Readonly<Record<string, Arrow>> = {
  '▲': 'up',
  '◄': 'left',
  '►': 'right'
}

export interface KeyFace {
  /** The encoder's 5-bit code — what reaches the PIA when this cap is pressed. */
  code: number

  /** What is legended on the cap, for the keys that carry text. */
  label: string

  /**
   * The sixteen keys with a hex value are digits and are legended black on
   * white; the eight without are commands, white on black. That is how the real
   * pad reads, and `value` is already the thing that tells them apart.
   */
  kind: 'hex' | 'function'

  /** Which arrow icon this cap carries, or null when it carries its label. */
  arrow: Arrow | null

  /** CSS grid position: 1-based, unlike the map's own row/col. */
  row: number
  column: number

  /** The host `KeyboardEvent.code`s that press it. */
  keys: readonly string[]

  /** `$0A`, for a tooltip that says what the cap actually sends. */
  hex: string
}

function face(key: KeypadKey): KeyFace {
  return {
    code: key.code,
    label: key.label,
    kind: key.value === undefined ? 'function' : 'hex',
    arrow: ARROWS[key.label] ?? null,
    row: key.row + 1,
    column: key.col + 1,
    keys: key.keys,
    hex: `$${key.code.toString(16).toUpperCase().padStart(2, '0')}`
  }
}

/** Every cap on the pad, in reading order. */
export const KEY_FACES: readonly KeyFace[] = KEYPAD.map(face)

/**
 * The grid the caps are laid into, so the panel cannot disagree with the map.
 *
 * The pad keeps its 4 × 6 proportions whatever the window does — a stretched
 * keypad is the one distortion you notice immediately, because the caps are
 * square on the real thing. The letterboxing is arithmetic in container units
 * rather than an `aspect-ratio`: a grid whose only sizing is a ratio and a pair
 * of max-* constraints has nothing to compute a size *from* inside a centring
 * flex box — the buttons have no intrinsic size either — so it collapses to
 * nothing. `cqw`/`cqh` are absolute lengths, so unlike percentages they can be
 * compared across the two axes.
 */
export const GRID_STYLE = {
  gridTemplateColumns: `repeat(${KEYPAD_COLS}, 1fr)`,
  gridTemplateRows: `repeat(${KEYPAD_ROWS}, 1fr)`,
  width: `min(100cqw, 100cqh * ${KEYPAD_COLS} / ${KEYPAD_ROWS})`,
  height: `min(100cqh, 100cqw * ${KEYPAD_ROWS} / ${KEYPAD_COLS})`
} as const
