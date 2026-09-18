/**
 * Argument helpers shared by the CLI commands.
 *
 * Every one of these reports failure by throwing UsageError, which the entry
 * point turns into a message and exit code 1. Silently coercing a bad argument
 * would leave someone debugging their 6502 program instead of their command
 * line.
 *
 * Two of 6502-EMULATOR's helpers do not come across. `parseFrequency` has
 * nothing to choose from — PHI2 on this board is 1 MHz and the 2 MHz jumper is
 * the ACE's — and `parseClock` had one caller, `--rtc`, which existed to pin the
 * one input to the engine that read the host clock. A KIM has no clock card, so
 * there is nothing to pin and every run is already reproducible.
 */

import { ACCESSORIES, accessoryFor } from '../core/accessories/registry'

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
 * A serial line's framing, written the way every terminal program writes it:
 * `8N1`, `7E2`. Data bits, parity, stop bits.
 */
/**
 * `--flow-control` / `--no-flow-control`: whether the far end honours RTS.
 * Undefined when neither was given, so a caller can fall back to its default
 * (on) or, in the app, to the saved setting.
 */
/**
 * `--serial-flow rtscts|none`: flow control on the *host's* port.
 *
 * Deliberately not the same flag as `--[no-]flow-control`, which says how the
 * far end of the *emulated* machine's ACIA behaves. Both answer "does this
 * terminal honour RTS", but one is about a cable and the other about a model,
 * and a run can want different answers.
 */
export function parseSerialFlow(text: string, label: string): boolean {
  const normalised = text.trim().toLowerCase()
  if (normalised === 'rtscts') return true
  if (normalised === 'none') return false
  throw new UsageError(`${label}: expected rtscts or none, got "${text}"`)
}

export function parseFlowControlFlags(values: {
  'flow-control'?: boolean
  'no-flow-control'?: boolean
}): boolean | undefined {
  const on = values['flow-control'] === true
  const off = values['no-flow-control'] === true
  if (on && off) throw new UsageError('--flow-control and --no-flow-control cannot both be given')
  return on ? true : off ? false : undefined
}

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
