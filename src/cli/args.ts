/**
 * Argument helpers shared by the CLI commands.
 *
 * Every one of these reports failure by throwing UsageError, which the entry
 * point turns into a message and exit code 1. Silently coercing a bad argument
 * would leave someone debugging their 6502 program instead of their command
 * line.
 *
 * Two of 6502-EMULATOR's helpers do not come across. `parseFrequency` has
 * nothing to choose from — PHI2 on this board is 1 MHz — and `parseClock` had
 * one caller, `--rtc`, which existed to pin the
 * one input to the engine that read the host clock. A KIM has no clock card, so
 * there is nothing to pin and every run is already reproducible.
 */

import { ACCESSORIES, accessoryFor } from '../core/accessories/registry'
import { SERIAL_CARDS, normalizeSerialCard } from '../core/IO/SerialCard'
import type { SerialCardConfig } from '../core/IO/SerialCard'
import {
  DEFAULT_SERIAL_CARD,
  SERIAL_CARDS_OFFERED,
  SERIAL_CARD_NOT_A_KIM,
  parseJumperPosition,
  parseSerialCard
} from '../shared/serialCard'

export class UsageError extends Error {}

/**
 * Parse an address written the way a 6502 programmer writes one: `$0800`,
 * `0x0800`, or plain decimal. Symbol names are resolved by the debug core,
 * which is why `dbg` passes addresses through as strings rather than using this.
 */
export function parseAddress(text: string, label = 'address'): number {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value = hex === null ? Number(trimmed) : parseInt(hex, 16)

  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new UsageError(`${label}: expected an address in $0000-$FFFF, got "${text}"`)
  }
  return value
}

/** `--bin 0x0800=counter.bin` — an address and the file to place there. */
export function parseBinarySpec(spec: string): { address: number; path: string } {
  const split = spec.indexOf('=')
  if (split === -1) {
    throw new UsageError(`--bin: expected <address>=<file>, got "${spec}"`)
  }
  return {
    address: parseAddress(spec.slice(0, split), '--bin'),
    path: spec.slice(split + 1)
  }
}

/**
 * A single byte, written the way a 6502 programmer writes one: `$EA`, `0xEA`,
 * or plain decimal. Zero is a value, not an omission — `mem fill … 0` is the
 * most common fill there is, so this must not borrow parseCount's
 * "positive number" rule.
 */
export function parseByte(text: string, label: string): number {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value =
    hex === null
      ? /^\d+$/.test(trimmed)
        ? Number(trimmed)
        : NaN
      : /^[0-9a-f]+$/i.test(hex)
        ? parseInt(hex, 16)
        : NaN

  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new UsageError(`${label}: expected a byte in $00-$FF, got "${text}"`)
  }
  return value
}

/** A count of things, for `--max-cycles`. Accepts `10_000_000` and `5e6`. */
export function parseCount(text: string, label: string): number {
  const value = Number(text.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${label}: expected a positive number, got "${text}"`)
  }
  return Math.floor(value)
}

/**
 * A position in the console's output stream, for `--since`.
 *
 * Zero is the start of the stream, not a missing argument: a machine that has
 * printed nothing yet hands out a cursor of 0, and `--since 0` asking for
 * everything the console has ever produced is the useful answer, not an error.
 */
export function parseCursor(text: string, label: string): number {
  const value = Number(text.replace(/_/g, ''))
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${label}: expected a stream position, got "${text}"`)
  }
  return value
}

/** A duration: bare seconds, or suffixed `500ms`, `30s`, `5m`. */
export function parseDuration(text: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim())
  if (!match) {
    throw new UsageError(`${label}: expected a duration like 30s, 500ms or 5m, got "${text}"`)
  }
  const value = Number(match[1])
  switch (match[2]) {
    case 'ms':
      return value
    case 'm':
      return value * 60_000
    default:
      return value * 1000
  }
}

/**
 * `--accessory led-latch` — which circuit is wired to the bus at `$9400`.
 *
 * Checked against the registry here rather than left to the machine, which
 * leaves the bay empty for an id it does not recognise. That is right for a
 * settings file written by a later version and wrong for a command line: a typo
 * should be a message in the terminal, not a run that quietly proves nothing.
 */
export function parseAccessory(id: string): string {
  if (accessoryFor(id)) return id
  const known = ACCESSORIES.map((accessory) => accessory.id).join(', ')
  throw new UsageError(`--accessory: no accessory "${id}" — this build has ${known}`)
}

/**
 * `--serial-flow rtscts|none`: flow control on the *host's* port. Deprecated
 * in 1.2 and ignored.
 *
 * The app now opens a real port with the OS's own RTS/CTS off and has the
 * emulated machine do the handshake: its RTS drives the port's RTS line, and
 * the port's CTS reaches the chip wherever the card's jumper connects it to
 * the cable. An OS doing RTS/CTS as well would fight the machine for the line.
 *
 * Still parsed, so a typo is still an error and a script that passes it keeps
 * running, for one release. The value says nothing.
 */
export function parseSerialFlow(text: string, label: string): boolean {
  const normalised = text.trim().toLowerCase()
  if (normalised === 'rtscts') return true
  if (normalised === 'none') return false
  throw new UsageError(`${label}: expected rtscts or none, got "${text}"`)
}

/** What a run says when it is given `--serial-flow`. */
export const SERIAL_FLOW_DEPRECATED =
  '--serial-flow is deprecated and ignored: the machine drives the port\'s RTS itself, ' +
  'and the card\'s CTS EN jumper decides whether the port\'s CTS can stop it (--cts cable)'

/**
 * Whether the far end of the console honours the machine's RTS:
 * `--peer-rts honour|ignore`, or the older `--flow-control` /
 * `--no-flow-control`, which say the same and are deprecated in 1.2 but still
 * work. Undefined when none was given, so a caller can fall back to its default
 * (honour) or, in the app, to the saved setting.
 *
 * This is the console, the Paste box or a pipe, never a real port: a real
 * device honours RTS or not by itself.
 */
export function parseFlowControlFlags(values: {
  'flow-control'?: boolean
  'no-flow-control'?: boolean
  'peer-rts'?: string
}): boolean | undefined {
  const on = values['flow-control'] === true
  const off = values['no-flow-control'] === true
  if (on && off) throw new UsageError('--flow-control and --no-flow-control cannot both be given')
  const legacy = on ? true : off ? false : undefined

  const text = values['peer-rts']
  if (text === undefined) return legacy

  const normalised = text.trim().toLowerCase()
  const honours =
    normalised === 'honour' || normalised === 'honor'
      ? true
      : normalised === 'ignore'
        ? false
        : null
  if (honours === null) {
    throw new UsageError(`--peer-rts: expected "honour" or "ignore", got "${text}"`)
  }
  if (legacy !== undefined && legacy !== honours) {
    throw new UsageError(
      `--peer-rts ${normalised} and --${legacy ? '' : 'no-'}flow-control say opposite things`
    )
  }
  return honours
}

/**
 * `--serial-card standard|pro`, `--cts ground|cable`, `--dcd ground|cable`:
 * which serial card io5 holds and where its jumpers are. Undefined when none
 * was given.
 *
 * A jumper without a card belongs to the default card, the Serial Card, as a
 * framing without a port belongs to the default port settings: the flags
 * describe a whole card, never half of one merged into whatever was saved. A
 * jumper the card does not have is refused rather than dropped, because
 * someone asked for it and the board cannot do it.
 *
 * With `--no-serial-card` there is no card to describe, so any of the three
 * is refused rather than quietly saying nothing.
 *
 * `ace` is refused with a reason of its own rather than the list of cards.
 * It is a real card in `SerialCard.ts`, and 6502-EMULATOR takes it, so someone
 * porting a command line from there should hear why it does not fit here, not
 * that it is a typo.
 */
export function parseSerialCardFlags(values: {
  'serial-card'?: string
  cts?: string
  dcd?: string
  'no-serial-card'?: boolean
}): SerialCardConfig | undefined {
  const cardText = values['serial-card']
  const given = (['serial-card', 'cts', 'dcd'] as const).filter((flag) => values[flag] !== undefined)
  if (given.length === 0) return undefined

  if (values['no-serial-card']) {
    throw new UsageError(
      `${given.map((flag) => `--${flag}`).join(', ')}: describes the card in io5, ` +
        'and --no-serial-card leaves io5 vacant'
    )
  }

  let card = DEFAULT_SERIAL_CARD.card
  if (cardText !== undefined) {
    const parsed = parseSerialCard(cardText)
    if (parsed === null) {
      if (cardText.trim().toLowerCase() === 'ace') {
        throw new UsageError(`--serial-card ace: ${SERIAL_CARD_NOT_A_KIM}`)
      }
      throw new UsageError(
        `--serial-card: expected ${SERIAL_CARDS_OFFERED.map((c) => `"${c}"`).join(' or ')}, got "${cardText}"`
      )
    }
    card = parsed
  }

  const spec = SERIAL_CARDS[card]
  const jumpers: SerialCardConfig['jumpers'] = {}
  for (const pin of ['cts', 'dcd'] as const) {
    const text = values[pin]
    if (text === undefined) continue
    const position = parseJumperPosition(text)
    if (position === null) {
      throw new UsageError(`--${pin}: expected "ground" or "cable", got "${text}"`)
    }
    const wiring = spec.wiring[pin]
    if (wiring !== 'jumper') {
      const where = wiring === 'ground' ? 'is tied to ground' : 'always reaches the cable'
      throw new UsageError(
        `--${pin}: the ${spec.name} has no ${pin.toUpperCase()} jumper — its ${pin.toUpperCase()} ${where}`
      )
    }
    jumpers[pin] = position
  }

  return normalizeSerialCard({ card, jumpers })
}

/**
 * A serial line's framing, written the way every terminal program writes it:
 * `8N1`, `7E2`. Data bits, parity, stop bits.
 */
export function parseSerialFraming(
  text: string,
  label: string
): { dataBits: 5 | 6 | 7 | 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2 } {
  const match = /^([5-8])([neo])([12])$/i.exec(text.trim())
  if (!match) {
    throw new UsageError(`${label}: expected framing like 8N1 or 7E2, got "${text}"`)
  }
  const parity = { n: 'none', e: 'even', o: 'odd' } as const
  return {
    dataBits: Number(match[1]) as 5 | 6 | 7 | 8,
    parity: parity[match[2]!.toLowerCase() as 'n' | 'e' | 'o'],
    stopBits: Number(match[3]) as 1 | 2
  }
}
