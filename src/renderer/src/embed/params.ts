import { accessoryFor, ACCESSORIES } from '@core/accessories/registry'
import { parseKeys } from './keys'

/**
 * The embed page's URL parameter API.
 *
 * Deliberately free of Vue and of the DOM — the entire configuration surface is
 * testable as plain TypeScript under the existing node-environment Jest setup.
 * Anything that needs a browser (fetching a URL, mounting the app) lives in
 * `media.ts` and `EmbedApp.vue`. The two core modules it does reach for,
 * `KeypadMap` (through `./keys`) and the accessory registry, are lookup tables:
 * they are here so that a mistyped key or an accessory this build has never
 * heard of is reported at parse time, next to every other malformed parameter,
 * rather than discovered silently three steps later.
 *
 * Two rules run through the whole file:
 *
 * 1. **Nothing here is fatal.** A malformed value falls back to its default and
 *    records a warning; an unknown parameter is ignored outright. A docs site
 *    pins an emulator version and then starts passing a parameter that version
 *    has never heard of — that has to degrade to "the emulator still boots",
 *    not to a blank frame.
 * 2. **Every source of bytes has a `64` twin.** `rom`/`rom64`, `bin`/`bin64`. A
 *    URL needs CORS on whatever host serves it *and* a `connect-src` that
 *    permits it; an inline base64 payload needs neither, which is what makes a
 *    self-contained snippet on a third-party page possible at all.
 *
 * ## What a KIM does not have
 *
 * 6502-EMULATOR's embed takes `cart`, `prg`, `cf`, `cfsize`, `persist`, `muted`
 * and `freq`. Every one of them went with hardware this machine does not carry:
 * there is no cartridge slot (the Keypad Card *is* the cartridge and it is
 * soldered in), no BASIC to load a `.prg` into, no CompactFlash, no sound, and
 * one clock — PHI2 on this board is 1 MHz, so `freq` would be offering a jumper
 * that is not on it. Nothing persists either, because a real KIM loses its RAM
 * when you switch it off.
 *
 * What replaces them is the machine's own shape — `accessory` and `serialcard`,
 * the two things `AppSettings` keeps — plus `panels` and `keys`, which have no
 * counterpart upstream because no other machine in the family is four separate
 * physical objects with a 24-key pad among them.
 *
 * The Keypad Card's own ROM is **not** a parameter. It is loadable in the app,
 * from Settings, because trying a freshly built `KC Monitor.bin` without burning
 * an AT28C64 is a real thing to want — but that is changing the machine's
 * firmware, and it belongs where you have to mean it. An embed is a guest on
 * someone else's page and is the opposite of that.
 */

export type ControlsMode = 'full' | 'minimal' | 'none'

/**
 * Whether the on-screen keyboard starts up.
 *
 * Three states rather than a flag, because the useful default is neither on nor
 * off. `auto` is resolved in the browser — see `EmbedApp.vue` — and comes out on
 * for a device that has no keyboard of its own and off for one that has. That
 * asymmetry is the point: a phone with no board on screen cannot type at the
 * serial line at all, and a desktop that opens one has given up a third of the
 * frame to something the reader already has under their hands.
 *
 * The pad is not affected either way. It is a panel, it is drawn at every size,
 * and a finger works on it — this board is the machine's *other* input path.
 */
export type KeyboardMode = 'auto' | 'on' | 'off'

/** The four things you can look at. `panels=` names a subset. */
export type PanelName = 'terminal' | 'lcd' | 'keys' | 'accessory'

export const ALL_PANELS: readonly PanelName[] = ['terminal', 'lcd', 'keys', 'accessory']

/** Where a piece of media comes from: fetched, or carried in the URL itself. */
export type MediaSource =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'inline'; bytes: Uint8Array; label: string }

/** A `bin` / `bin64` entry: raw bytes and the address they belong at. */
export interface BinarySource {
  address: number
  source: MediaSource
}

export interface EmbedParams {
  /** BIOS image; null means the bundled one. */
  rom: MediaSource | null
  binaries: BinarySource[]
  /** Registry id of the circuit wired to the bay at $9400, or null for empty. */
  accessory: string | null
  /** Whether io5 holds the ACIA. `false` gives the keypad-only machine. */
  serialCard: boolean
  autostart: boolean
  /** Text typed down the serial line once the machine is up, or null. */
  autotype: string | null
  /** Encoder codes keyed on the pad once the machine is up. Empty for none. */
  keys: number[]
  /** Which panels are shown, in a stable order. Never empty. */
  panels: PanelName[]
  controls: ControlsMode
  /** Whether the on-screen keyboard starts up; `auto` decides in the browser. */
  keyboard: KeyboardMode
  /**
   * Origins allowed to drive this embed over postMessage, or null for "any".
   * See `messaging.ts` for why null is the default.
   */
  origins: string[] | null
  /** Human-readable notes about anything that was ignored or corrected. */
  warnings: string[]
}

/**
 * The top of RAM, which is as high as a `bin` can be written.
 *
 * $8000 and up is the I/O window, and above that the Kernal, the PIA and the
 * card's own ROM — none of which a write reaches. `ProgramImage.loadBinary`
 * refuses an image that would run off the top; this refuses a *start* that is
 * already past it, which is the mistake worth naming at parse time.
 */
const RAM_TOP = 0x7fff

const DISPLAY_NAMES: Record<string, string> = {
  rom: 'BIOS ROM',
  bin: 'Binary'
}

// ── base64 ───────────────────────────────────────────────────────────────────

const BASE64_VALUES: Record<string, number> = (() => {
  const table: Record<string, number> = {}
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < alphabet.length; i++) table[alphabet[i]!] = i
  // The URL-safe alphabet (RFC 4648 §5), so a payload generated with
  // `base64url` needs no translation on the way in.
  table['-'] = 62
  table['_'] = 63
  // A query string decodes `+` to a space, so plain base64 pasted into a URL
  // arrives with its 62nd character replaced. Accepting the space is friendlier
  // than requiring every caller to percent-encode by hand, and a space means
  // nothing else here.
  table[' '] = 62
  return table
})()

/**
 * Decode a base64 payload as it arrives from a URL parameter.
 *
 * Hand-rolled rather than `atob` for two reasons: it runs identically in the
 * browser and in the node-environment test suite, and it *rejects* junk instead
 * of quietly tolerating it — a mistyped payload should surface as a warning
 * about that parameter, not as an emulator loading half a program.
 *
 * Accepts the standard and URL-safe alphabets, optional padding, embedded
 * whitespace, and a leading `data:...;base64,` prefix.
 *
 * @throws if the text contains anything that is not base64.
 */
export function decodeBase64(text: string): Uint8Array {
  const payload = text.replace(/^data:[^,]*;base64,/i, '').replace(/[\r\n\t]/g, '')

  const bytes: number[] = []
  let bits = 0
  let bitCount = 0

  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!
    if (ch === '=') {
      // Padding, and nothing but padding, may follow.
      const stray = /[^=]/.exec(payload.slice(i))
      if (stray) throw new Error(`unexpected "${stray[0]}" after base64 padding`)
      break
    }
    const value = BASE64_VALUES[ch]
    if (value === undefined) throw new Error(`invalid base64 character "${ch}"`)
    // Masked, or the accumulator overflows after a handful of characters — the
    // low 14 bits are all `bitCount` can ever reach back into.
    bits = ((bits << 6) | value) & 0x3fff
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      bytes.push((bits >> bitCount) & 0xff)
    }
  }

  return Uint8Array.from(bytes)
}

// ── scalar values ────────────────────────────────────────────────────────────

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on', ''])
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off'])

/**
 * A flag, in any of the spellings someone hand-writing a URL might reach for.
 * A bare `?autostart` with no value counts as true — that is what writing it at
 * all means.
 */
function readBoolean(
  raw: string | null,
  key: string,
  fallback: boolean,
  warnings: string[]
): boolean {
  if (raw === null) return fallback
  const value = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(value)) return true
  if (FALSE_WORDS.has(value)) return false
  warnings.push(`${key}: expected 1 or 0, got "${raw}" — using ${fallback ? '1' : '0'}.`)
  return fallback
}

/**
 * An address the way a 6502 programmer writes one — `$0800`, `0x0800` or plain
 * decimal — matching `parseAddress` in the CLI so `--bin` and `bin=` accept the
 * same spellings.
 */
function parseAddress(text: string): number | null {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value = hex === null ? Number(trimmed) : parseInt(hex, 16)
  if (trimmed === '' || !Number.isInteger(value) || value < 0 || value > RAM_TOP) return null
  return value
}

/**
 * `\r`, `\n`, `\t`, `\\` and `\xNN` written literally, because
 * `autotype=\x1b0800: A9 41\r` is what anyone writing this parameter by hand
 * will type. Percent-encoded control characters arrive already decoded and pass
 * through untouched.
 *
 * `\xNN` is here for the same reason the CLI's `unescape` learned it: the splash
 * reads `--ESC TO START--` and means it, so the first byte anything types at
 * this machine is usually an ESC — and while a URL *can* carry `%1B`, a
 * parameter hand-written into an `<iframe>` tag is exactly as awkward a place to
 * put a raw control character as a shell argument is.
 */
function unescapeText(text: string): string {
  return text.replace(/\\(?:x([0-9a-fA-F]{2})|([rnt\\]))/g, (_, hex: string, ch: string) => {
    if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16))
    return ch === 'r' ? '\r' : ch === 'n' ? '\n' : ch === 't' ? '\t' : '\\'
  })
}

/** The last path segment of a URL, for the "loaded file" labels the store keeps. */
function labelFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url
  const segment = withoutQuery.split('/').filter(Boolean).pop()
  if (!segment) return url
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// ── media ────────────────────────────────────────────────────────────────────

/**
 * One media slot from its two spellings. `<key>64` wins when both are present:
 * it is already in hand and needs no network at all, so preferring it can only
 * make the embed load in fewer round trips.
 */
function readMedia(query: URLSearchParams, key: string, warnings: string[]): MediaSource | null {
  const inline = query.get(`${key}64`)
  const url = query.get(key)
  const name = DISPLAY_NAMES[key] ?? key

  if (inline !== null) {
    if (url !== null) {
      warnings.push(`${key} and ${key}64 both given — using ${key}64.`)
    }
    return decodeInline(inline, `${key}64`, name, warnings)
  }

  if (url === null) return null
  const trimmed = url.trim()
  if (!trimmed) {
    warnings.push(`${key}: empty — ignored.`)
    return null
  }
  return { kind: 'url', url: trimmed, label: labelFromUrl(trimmed) }
}

function decodeInline(
  payload: string,
  key: string,
  name: string,
  warnings: string[]
): MediaSource | null {
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(payload)
  } catch (e) {
    warnings.push(`${key}: ${(e as Error).message} — ignored.`)
    return null
  }
  if (bytes.length === 0) {
    warnings.push(`${key}: decoded to no bytes — ignored.`)
    return null
  }
  return { kind: 'inline', bytes, label: `${name} (inline)` }
}

/**
 * `bin` and `bin64` in the order they appear in the URL, because they are
 * writes to memory and two of them can overlap. Whatever the author wrote last
 * should land last, whichever spelling they used for each.
 */
function readBinaries(query: URLSearchParams, warnings: string[]): BinarySource[] {
  const binaries: BinarySource[] = []

  for (const [key, value] of query.entries()) {
    if (key !== 'bin' && key !== 'bin64') continue

    const split = value.indexOf('=')
    if (split === -1) {
      warnings.push(
        `${key}: expected <address>=${key === 'bin' ? '<url>' : '<base64>'}, got "${value}" — ignored.`
      )
      continue
    }

    const address = parseAddress(value.slice(0, split))
    if (address === null) {
      warnings.push(
        `${key}: expected an address in $0000-$7FFF, got "${value.slice(0, split)}" — ignored.`
      )
      continue
    }

    // First `=` only: base64 padding is made of them, so the rest of the value
    // belongs to the payload.
    const rest = value.slice(split + 1)
    const source =
      key === 'bin64'
        ? decodeInline(rest, 'bin64', DISPLAY_NAMES.bin!, warnings)
        : rest.trim()
          ? ({ kind: 'url', url: rest.trim(), label: labelFromUrl(rest.trim()) } as MediaSource)
          : null

    if (!source) {
      if (key === 'bin') warnings.push('bin: empty URL — ignored.')
      continue
    }
    binaries.push({ address, source })
  }

  return binaries
}

// ── the parser ───────────────────────────────────────────────────────────────

/**
 * Read the embed's configuration out of a query string.
 *
 * Accepts a raw `location.search` (leading `?` and all) or an already-built
 * `URLSearchParams`. Never throws.
 */
export function parseEmbedParams(search: string | URLSearchParams = ''): EmbedParams {
  const query = typeof search === 'string' ? new URLSearchParams(search) : search
  const warnings: string[] = []

  // Read before the return, because `keyboard` depends on it: the board types
  // down the serial line, and a machine with io5 vacant has no line.
  const serialCard = readBoolean(query.get('serialcard'), 'serialcard', true, warnings)

  return {
    rom: readMedia(query, 'rom', warnings),
    binaries: readBinaries(query, warnings),
    accessory: readAccessory(query, warnings),
    serialCard,
    autostart: readBoolean(query.get('autostart'), 'autostart', true, warnings),
    autotype: readAutotype(query, warnings),
    keys: readKeys(query, warnings),
    panels: readPanels(query, warnings),
    controls: readControls(query, warnings),
    keyboard: readKeyboard(query, serialCard, warnings),
    origins: readOrigins(query),
    warnings
  }
}

/**
 * `keyboard=1|0|auto`, sharing the flag words with every other boolean here so
 * that `keyboard=yes` and `keyboard=on` mean what they look like — and a bare
 * `?keyboard` means on, which is what writing it at all means.
 *
 * `auto` is a third state and not a fallback: it survives to `EmbedApp.vue`,
 * which is the only place that can ask the browser whether this device has a
 * keyboard already.
 *
 * Without a Serial Card there is nowhere for a byte to go — `useConsole.send`
 * checks for the ACIA and returns — so the board is refused outright rather than
 * drawn as a third of the frame that does nothing when you press it. Silently
 * when the author did not ask for it; with a warning when they did, because
 * `serialcard=0&keyboard=1` is two instructions that contradict each other and
 * the second one is the one that cannot be honoured.
 */
function readKeyboard(
  query: URLSearchParams,
  serialCard: boolean,
  warnings: string[]
): KeyboardMode {
  const raw = query.get('keyboard')
  const mode = readKeyboardMode(raw, warnings)
  if (serialCard || mode === 'off') return mode
  if (mode === 'on') {
    warnings.push('keyboard: no Serial Card fitted — there is nowhere for the bytes to go.')
  }
  return 'off'
}

function readKeyboardMode(raw: string | null, warnings: string[]): KeyboardMode {
  if (raw === null) return 'auto'
  const value = raw.trim().toLowerCase()
  if (value === 'auto') return 'auto'
  if (TRUE_WORDS.has(value)) return 'on'
  if (FALSE_WORDS.has(value)) return 'off'
  warnings.push(`keyboard: expected 1, 0 or auto, got "${raw}" — using auto.`)
  return 'auto'
}

/**
 * What is wired to the bay at $9400.
 *
 * The value is a registry id — the same string `--accessory` takes and settings
 * persist, because a circuit's id *is* its `IO.kind` all the way down. Absent,
 * empty or `none` leaves the bay vacant, which is what a KIM is with nothing
 * plugged in.
 */
function readAccessory(query: URLSearchParams, warnings: string[]): string | null {
  const raw = query.get('accessory')
  if (raw === null) return null

  const id = raw.trim().toLowerCase()
  if (id === '' || id === 'none' || id === 'empty') return null

  if (!accessoryFor(id)) {
    const known = ACCESSORIES.map((accessory) => accessory.id).join(', ')
    warnings.push(`accessory: no circuit called "${raw}" — the bay is empty. Known: ${known}.`)
    return null
  }
  return id
}

function readAutotype(query: URLSearchParams, warnings: string[]): string | null {
  const raw = query.get('autotype')
  if (raw === null) return null
  const text = unescapeText(raw)
  if (!text) {
    warnings.push('autotype: empty — ignored.')
    return null
  }
  return text
}

/** A keying sequence — `keys=0,8,0,0,UP`. See `./keys` for the naming rule. */
function readKeys(query: URLSearchParams, warnings: string[]): number[] {
  const raw = query.get('keys')
  if (raw === null) return []

  const { codes, error } = parseKeys(raw)
  if (error) {
    warnings.push(`keys: ${error} — ignored.`)
    return []
  }
  return codes
}

const PANEL_ALIASES: Readonly<Record<string, PanelName>> = {
  terminal: 'terminal',
  term: 'terminal',
  serial: 'terminal',
  lcd: 'lcd',
  display: 'lcd',
  keys: 'keys',
  keypad: 'keys',
  pad: 'keys',
  accessory: 'accessory',
  bay: 'accessory',
  leds: 'accessory'
}

/**
 * Which of the four panels are shown.
 *
 * Absent means all of them. A subset is the point of the parameter: a docs page
 * explaining the pad wants `panels=lcd,keys` and nothing else, because the
 * terminal and the bay are not what that paragraph is about.
 *
 * Hiding a panel hides the *view*, never the hardware. The LCD is still being
 * driven, the ACIA still transmits, and the latch still lights lamps nobody can
 * see — the machine on a KIM is not assembled out of its panels.
 *
 * A list naming nothing recognisable falls back to all four rather than to an
 * empty frame: a blank rectangle is indistinguishable from a broken embed.
 */
function readPanels(query: URLSearchParams, warnings: string[]): PanelName[] {
  const raw = query.get('panels')
  if (raw === null) return [...ALL_PANELS]

  const wanted = new Set<PanelName>()
  for (const token of raw.split(',').map((name) => name.trim().toLowerCase())) {
    if (!token) continue
    const panel = PANEL_ALIASES[token]
    if (!panel) {
      warnings.push(`panels: no panel called "${token}" — ignored.`)
      continue
    }
    wanted.add(panel)
  }

  if (wanted.size === 0) {
    warnings.push('panels: nothing recognised — showing all four.')
    return [...ALL_PANELS]
  }
  // Layout order, not the order they were written: the panels stand for parts of
  // a machine that sits a particular way round on the bench.
  return ALL_PANELS.filter((panel) => wanted.has(panel))
}

function readControls(query: URLSearchParams, warnings: string[]): ControlsMode {
  const raw = query.get('controls')
  if (raw === null) return 'minimal'
  const value = raw.trim().toLowerCase()
  if (value === 'full' || value === 'minimal' || value === 'none') return value
  warnings.push(`controls: expected full, minimal or none, got "${raw}" — using minimal.`)
  return 'minimal'
}

/**
 * Origins permitted to drive the embed over postMessage.
 *
 * Absent — or `*` — means any, which is what lets a raw `<iframe>` on someone
 * else's CDN work with no configuration at all. The exposure is bounded: the
 * emulator holds no credentials and cannot see the host page, so the worst a
 * hostile framer can do is drive the emulated machine it is already framing.
 * Naming origins narrows it to those; see docs/EMBEDDING.md.
 */
function readOrigins(query: URLSearchParams): string[] | null {
  const raw = query.get('origins')
  if (raw === null) return null
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (origins.length === 0 || origins.includes('*')) return null
  return origins
}
