import { onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { usePaste } from '@/composables/usePaste'
import { decodeBase64 } from './params'
import { parseKeys } from './keys'
import type { Keyer } from './keys'
import { keyForCode } from '@core/KeypadMap'
import type { StopReason } from '@debug/Session'

/**
 * The `postMessage` control API.
 *
 * What it is for: a docs page putting a "Run this" button beside a code block,
 * without reloading the iframe or round-tripping through a URL. Everything the
 * URL parameters can do at load time, this can do at any time.
 *
 * Message names are prefixed `6502-kim:` rather than 6502-EMULATOR's `6502:`,
 * for the same reason the lock file is `~/.6502-kim` and a snapshot says
 * `6502-kim-snapshot`: the two emulators are separate machines, and a docs page
 * that frames both — which the DOCS site will — should not be able to reset the
 * wrong one by getting a `postMessage` target subtly wrong.
 */

export type EmbedInbound =
  | { type: '6502-kim:load'; kind: LoadKind; data: unknown; address?: number; label?: string }
  | { type: '6502-kim:run' }
  | { type: '6502-kim:pause' }
  | { type: '6502-kim:reset' }
  | { type: '6502-kim:powerCycle' }
  | { type: '6502-kim:type'; text: string }
  | { type: '6502-kim:key'; key?: unknown; keys?: unknown; kps?: number }

/**
 * What can be loaded into a running machine.
 *
 * Two, where the ACE has five. `cart`, `prg` and `cf` went with the hardware:
 * there is no cartridge slot, no BASIC and no CompactFlash. The Keypad Card's
 * own ROM is not here either — see `params.ts`; it is the machine's firmware
 * rather than something you hand it, and it belongs where you have to mean it.
 */
export type LoadKind = 'rom' | 'bin'

const LOAD_KINDS: readonly LoadKind[] = ['rom', 'bin']

/** Where `bin` goes when the message does not say. The type-in cards' address. */
const DEFAULT_BIN_ADDRESS = 0x0800

/**
 * Serial bytes are coalesced over this window before being posted out.
 *
 * The ACIA transmits one byte at a time; a `postMessage` per character while the
 * KC Monitor dumps a page of memory would be thousands of structured clones a
 * second for data the host page will only ever concatenate anyway.
 */
const SERIAL_FLUSH_MS = 32

export interface EmbedMessagingOptions {
  /** Origins allowed to send us commands; null accepts any. See params.ts. */
  origins: string[] | null
  /**
   * The pad, shared with the boot sequence's `keys=` so that a message arriving
   * mid-sequence takes the pad over rather than interleaving with it.
   */
  keyer: Keyer
  /**
   * Resolves once the machine can hear input — see EmbedApp. Everything that
   * *drives* the machine waits behind it; everything that operates the machine
   * (run, reset, load) does not, since that is what makes the machine run in the
   * first place.
   */
  whenReady: () => Promise<boolean>
  /** Reported alongside `6502-kim:ready` so a host can branch on what it got. */
  describe?: () => Record<string, unknown>
}

/** Coerce whatever a host page put in `data` into bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data)) return Uint8Array.from(data.map((n) => Number(n) & 0xff))
  // A string is base64 — the form that survives being written into a JSON blob
  // or an HTML attribute, which is how most host pages will carry a program.
  if (typeof data === 'string') {
    try {
      return decodeBase64(data)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Encoder codes from whatever shape the host page sent.
 *
 * A string is a sequence — `'0,8,0,0,UP'` — read by the same rules as `keys=`
 * and `6502-kim dbg key`: a bare token is a *name*, so `'0'` is the zero key and
 * reports $0A. A number is the encoder's own code, which is the one form that
 * cannot be a name. A list may mix the two.
 */
function toCodes(requested: unknown): number[] | null {
  const entries = Array.isArray(requested) ? requested : [requested]
  if (entries.length === 0) return null

  const codes: number[] = []
  for (const entry of entries) {
    if (typeof entry === 'number') {
      const key = keyForCode(entry)
      if (!key) return null
      codes.push(key.code)
      continue
    }
    if (typeof entry !== 'string') return null
    const { codes: parsed, error } = parseKeys(entry)
    if (error) return null
    codes.push(...parsed)
  }
  return codes.length > 0 ? codes : null
}

export function useEmbedMessaging(options: EmbedMessagingOptions) {
  const store = useEmulatorStore()
  const paste = usePaste()

  /**
   * Where outbound messages go.
   *
   * With `origins` configured, each named origin gets its own post and the
   * browser drops it unless the frame's parent really is that origin. Without,
   * `'*'` — the same open default the inbound side runs, documented in
   * docs/EMBEDDING.md. Nothing we send contains anything the host page did not
   * already give us or could not already see on screen.
   */
  function post(message: Record<string, unknown>): void {
    if (window.parent === window) return
    for (const origin of options.origins ?? ['*']) {
      try {
        window.parent.postMessage(message, origin)
      } catch {
        /* a host that went away mid-run is not our problem */
      }
    }
  }

  function allowed(origin: string): boolean {
    return options.origins === null || options.origins.includes(origin)
  }

  function applyLoad(message: Extract<EmbedInbound, { type: '6502-kim:load' }>): void {
    const kind = message.kind
    if (!LOAD_KINDS.includes(kind)) return
    const bytes = toBytes(message.data)
    if (!bytes || bytes.length === 0) {
      console.warn('[embed] 6502-kim:load — no usable bytes in `data`')
      return
    }
    const label = message.label ?? `${kind} (postMessage)`

    switch (kind) {
      case 'rom':
        store.loadROM(bytes, label)
        // The BIOS does not hold this machine's vectors — those are the Keypad
        // Card's — but a machine mid-Kernal with half a new ROM under it is not
        // a state worth preserving either.
        store.resetCPU()
        break
      case 'bin':
        store.loadBinary(bytes, message.address ?? DEFAULT_BIN_ADDRESS, label)
        break
    }
  }

  function applyKey(message: Extract<EmbedInbound, { type: '6502-kim:key' }>): void {
    const requested = message.keys ?? message.key
    if (requested === undefined) {
      console.warn('[embed] 6502-kim:key — "keys" is required')
      return
    }

    const codes = toCodes(requested)
    if (!codes) {
      console.warn('[embed] 6502-kim:key — no such key on this pad:', requested)
      return
    }
    void options.whenReady().then((ready) => {
      if (ready) void options.keyer.play(codes, message.kps)
    })
  }

  /** Bytes at the ACIA, once there is firmware listening for them. */
  function applyType(text: string): void {
    void options.whenReady().then((ready) => {
      if (ready) void paste.injectText(text)
    })
  }

  function onMessage(event: MessageEvent): void {
    if (!allowed(event.origin)) return
    const message = event.data as EmbedInbound | null
    if (!message || typeof message !== 'object') return
    if (typeof message.type !== 'string' || !message.type.startsWith('6502-kim:')) return

    switch (message.type) {
      case '6502-kim:load':
        applyLoad(message)
        break
      case '6502-kim:run':
        store.run()
        break
      case '6502-kim:pause':
        store.stop()
        break
      case '6502-kim:reset':
        store.reset()
        break
      case '6502-kim:powerCycle':
        store.powerCycle()
        break
      case '6502-kim:type':
        if (typeof message.text === 'string') applyType(message.text)
        break
      case '6502-kim:key':
        applyKey(message)
        break
      default:
        // Unknown `6502-kim:` verbs are ignored, for the same reason unknown URL
        // parameters are: a host page may be newer than the pinned emulator.
        break
    }
  }

  // ── Outbound: serial ───────────────────────────────────────────────────────

  let serialBuffer: number[] = []
  let serialTimer: ReturnType<typeof setTimeout> | null = null

  function flushSerial(): void {
    serialTimer = null
    if (serialBuffer.length === 0) return
    const bytes = serialBuffer
    serialBuffer = []
    post({
      type: '6502-kim:serial',
      bytes,
      // The same bytes as text, since a host page logging the machine's output
      // would otherwise have to reimplement this on the other side.
      text: String.fromCharCode(...bytes.map((b) => b & 0x7f))
    })
  }

  // A tap on the ACIA's transmit line, not a second device — the terminal panel
  // holds one of its own, so this unsubscribes only ours.
  const untap = store.onTransmit((data: number) => {
    serialBuffer.push(data & 0xff)
    serialTimer ??= setTimeout(flushSerial, SERIAL_FLUSH_MS)
  })

  // ── Outbound: stops ────────────────────────────────────────────────────────

  const unsubscribeStop = store.session?.onStop((reason: StopReason) => {
    post({ type: '6502-kim:stopped', reason })
  })

  window.addEventListener('message', onMessage)

  onUnmounted(() => {
    window.removeEventListener('message', onMessage)
    if (serialTimer !== null) clearTimeout(serialTimer)
    untap()
    unsubscribeStop?.()
  })

  /** Announce the frame once the machine is up and the firmware is in. */
  function announceReady(): void {
    post({ type: '6502-kim:ready', ...(options.describe?.() ?? {}) })
  }

  return { announceReady, post }
}
