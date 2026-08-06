import { keyForCode, keyForName, keyNames } from '@core/KeypadMap'

/**
 * Keying sequences, for the two surfaces that can send one: the `keys=` URL
 * parameter and the `6502-kim:key` message.
 *
 * Kept out of both so the naming rules and the pacing have one description. The
 * naming rule is the CLI's, deliberately: a token is a **name** unless it is
 * written as hex. `0` presses the zero key, which reports $0A; `$0A` says the
 * same thing the other way. Reading a bare `0` as an encoder code would press
 * `◄`, and `KeypadMap` exists precisely so that nothing derives one from the
 * other.
 */

/** A parsed sequence, or the reason it was refused. */
export interface KeySequence {
  /** Encoder codes, in order. Empty when `error` is set. */
  codes: number[]
  /** What was wrong with it, or null. */
  error: string | null
}

/**
 * How fast a sequence is keyed, in keys per second.
 *
 * The pacing is not politeness. The 74C922 latches a single code and raises DA;
 * the KC Monitor reads it in the CA1 handler and that read is what clears the
 * latch. Two presses with no emulated time between them means the second
 * overwrites the first and the keystroke is simply gone. Eight a second is a
 * brisk finger, and leaves the handler a hundred thousand cycles.
 */
export const DEFAULT_KEYS_PER_SECOND = 8

/**
 * Read a comma-separated sequence — `0,8,0,0,UP` — into encoder codes.
 *
 * Names are the pad's legends, case-insensitively, plus `LEFT` / `RIGHT` / `UP`
 * / `ENTER` / `RUN` for the keys legended with a glyph. A token written `$14` or
 * `0x14` is the encoder's own code instead.
 *
 * **One bad token refuses the whole sequence.** Half an address keyed into the
 * monitor leaves it somewhere nobody asked for, which is worse than not keying
 * at all and much harder to see.
 */
export function parseKeys(text: string): KeySequence {
  const tokens = text
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return { codes: [], error: 'the sequence is empty' }

  const codes: number[] = []
  for (const token of tokens) {
    const hex = token.startsWith('$') ? token.slice(1) : /^0x/i.test(token) ? token.slice(2) : null

    if (hex !== null) {
      const code = /^[0-9a-f]{1,2}$/i.test(hex) ? parseInt(hex, 16) : NaN
      const key = Number.isNaN(code) ? undefined : keyForCode(code)
      if (!key) return { codes: [], error: `no key with code "${token}" on this pad` }
      codes.push(key.code)
      continue
    }

    const key = keyForName(token)
    if (!key) {
      return {
        codes: [],
        error: `no key "${token}" on this pad — try one of ${keyNames().join(', ')}`
      }
    }
    codes.push(key.code)
  }

  return { codes, error: null }
}

export interface PressOptions {
  /** Keys per second. */
  kps?: number
  /** Asked before each press; true abandons the rest of the sequence. */
  cancelled?: () => boolean
}

/** One sequence at a time, against one pad. */
export interface Keyer {
  /** Key a sequence, abandoning whatever was still being keyed. */
  play(codes: readonly number[], kps?: number): Promise<void>
  /** Abandon the sequence in flight. */
  cancel(): void
}

/**
 * A pad that can only be keyed by one hand.
 *
 * Two sequences pacing themselves against the same encoder would interleave,
 * and interleaved presses are not merely out of order — the 74C922 holds one
 * code, so each one lands on top of the last and most of both sequences is
 * lost. A second `play` therefore abandons the first rather than racing it,
 * which is also what a reader means by pressing a docs page's second button.
 */
export function createKeyer(press: (code: number) => void): Keyer {
  let token = 0

  return {
    async play(codes: readonly number[], kps?: number): Promise<void> {
      const mine = ++token
      await pressKeys(codes, press, { kps, cancelled: () => mine !== token })
    },
    cancel(): void {
      token++
    }
  }
}

/**
 * Press a sequence, paced.
 *
 * Paced in wall-clock rather than in emulated cycles, because the window runs
 * the session in realtime and has no way to step it — a millisecond here is a
 * thousand cycles there. The debug protocol's `keypad.press` does it the other
 * way for the same reason in reverse: it owns the scheduler.
 */
export async function pressKeys(
  codes: readonly number[],
  press: (code: number) => void,
  options: PressOptions = {}
): Promise<void> {
  const { kps = DEFAULT_KEYS_PER_SECOND, cancelled } = options
  const gap = 1000 / (kps > 0 ? kps : DEFAULT_KEYS_PER_SECOND)

  for (let i = 0; i < codes.length; i++) {
    if (cancelled?.()) return
    press(codes[i]!)
    if (i < codes.length - 1) await sleep(gap)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
