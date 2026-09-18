import { SERIAL_CARDS, jumpersOf, normalizeSerialCard } from '../core/IO/SerialCard'
import type { JumperPin, JumperPosition, SerialCardConfig, SerialCardModel } from '../core/IO/SerialCard'

/**
 * Choosing the serial card and its jumpers: one source for the CLI, the app
 * and the debug protocol.
 *
 * The card is named the same way everywhere — `--serial-card`,
 * `AppSettings.serialCard`, `session.info.serialCard` — and the values are
 * `SerialCardModel`'s, as in 6502-EMULATOR. The jumpers are `--cts` and
 * `--dcd`, `ground` or `cable`. `core/IO/SerialCard.ts` is the hardware; this
 * is what this app offers of it.
 */

/**
 * The cards this app offers: the COB's Serial Card, which is the KIM's own,
 * and the Serial Card Pro, which fits the same slot.
 *
 * Never the ACE. Its R6551 is on the ACE board itself, and there is no such
 * thing as fitting one to a KIM, so `--serial-card ace` is refused by name
 * rather than taken as a card this machine could have (`SERIAL_CARD_NOT_A_KIM`).
 */
export const SERIAL_CARDS_OFFERED: readonly SerialCardModel[] = ['standard', 'pro']

/**
 * The card a machine gets when nothing names one: the Serial Card, `CTS EN`
 * at ground, where every board has it. The same as `Machine`'s own
 * `DEFAULT_SERIAL_CARD`, which a test holds it to; kept here so that the main
 * process can name it without loading the machine.
 */
export const DEFAULT_SERIAL_CARD: SerialCardConfig = {
  card: 'standard',
  jumpers: { cts: 'ground' }
}

/** Why the ACE is not a card this app offers, for whoever asked for it. */
export const SERIAL_CARD_NOT_A_KIM =
  'the ACE\'s serial is on the ACE board, and cannot be fitted to a KIM — use 6502-EMULATOR for the ACE'

/** A card's name as a person typed it, or null if it names no card this app offers. */
export function parseSerialCard(raw: string | null | undefined): SerialCardModel | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim().toLowerCase() as SerialCardModel
  return SERIAL_CARDS_OFFERED.includes(value) ? value : null
}

/** A jumper position as a person typed it, or null. */
export function parseJumperPosition(raw: string | null | undefined): JumperPosition | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim().toLowerCase()
  return value === 'ground' || value === 'cable' ? value : null
}

/**
 * A card and jumpers read back from somewhere untrusted — a settings file, a
 * protocol call — or null if it names no card this app offers, the ACE
 * included. Jumpers the card lacks are dropped and unreadable ones are at
 * ground, as `normalizeSerialCard` does.
 */
export function readSerialCard(value: unknown): SerialCardConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const { card, jumpers } = value as { card?: unknown; jumpers?: unknown }
  const model = typeof card === 'string' ? parseSerialCard(card) : null
  if (!model) return null
  const given = (typeof jumpers === 'object' && jumpers !== null ? jumpers : {}) as Record<string, unknown>
  const read: SerialCardConfig['jumpers'] = {}
  for (const pin of jumpersOf(model)) {
    const position = typeof given[pin] === 'string' ? parseJumperPosition(given[pin] as string) : null
    if (position) read[pin] = position
  }
  return normalizeSerialCard({ card: model, jumpers: read })
}

/**
 * Whether a card is `DEFAULT_SERIAL_CARD`: the Serial Card, `CTS EN` at
 * ground. What `dbg info` and the banner leave unsaid.
 */
export function isDefaultSerialCard(config: SerialCardConfig): boolean {
  const normal = normalizeSerialCard(config)
  return (
    normal.card === DEFAULT_SERIAL_CARD.card &&
    jumpersOf(normal.card).every((pin) => normal.jumpers[pin] === DEFAULT_SERIAL_CARD.jumpers[pin])
  )
}

/**
 * The card and its jumpers as a person reads them off the board:
 * `Serial Card (CTS EN: cable)`, `Serial Card Pro (DCD Select: ground)`.
 */
export function describeSerialCard(config: SerialCardConfig): string {
  const normal = normalizeSerialCard(config)
  const spec = SERIAL_CARDS[normal.card]
  const jumpers = jumpersOf(normal.card).map(
    (pin: JumperPin) => `${spec.jumperLabels[pin]}: ${normal.jumpers[pin]}`
  )
  return jumpers.length > 0 ? `${spec.name} (${jumpers.join(', ')})` : spec.name
}
