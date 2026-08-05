import { ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { TerminalBuffer } from '@/terminal/TerminalBuffer'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'

/**
 * The machine's serial console, as the window sees it.
 *
 * One buffer for the whole app, wired once. The Terminal panel draws it, the
 * Paste box feeds it, and the debug protocol's `serial.*` methods read and write
 * the same one — which is the point. A second buffer somewhere would mean a
 * debug client and the window disagreeing about what the machine has said.
 *
 * Bytes in either direction are exactly the bytes on the wire: the tap below is
 * the ACIA's transmit line, and `send` hands bytes to `machine.onReceive` the
 * way a real port's arriving byte does. Connect a laptop and both views show the
 * same traffic.
 *
 * A machine with io5 vacant has no ACIA at all. Nothing here errors on that —
 * the keypad-only path is real hardware the KC Monitor supports, so output
 * simply never arrives and input goes nowhere.
 */

/** 8-N-1 puts a start and a stop bit around each byte: ten bits per character. */
const BITS_PER_BYTE = 10

/**
 * How often queued bytes are handed over. The ACIA queues what it is given and
 * delivers one byte per cycle as the firmware reads them, so this is about not
 * running ahead of the line rate rather than about overrun — a 20 ms tick at
 * 19200 baud is ~38 bytes, a plausible burst at a granularity nobody can see.
 */
const TICK_MS = 20

export interface Console {
  /** What the machine has said. Shared with the panel and the debug protocol. */
  readonly buffer: TerminalBuffer
  /** Tracks `buffer.version`, so a canvas can watch it and redraw. */
  readonly revision: Ref<number>
  /** Deliver bytes to the ACIA now — one keystroke, typed into the panel. */
  send: (data: Uint8Array | number[] | number) => void
  /** Deliver bytes paced at the line rate. Resolves when the last one is in. */
  queue: (data: Uint8Array, baudRate?: number) => Promise<void>
  /** Abandon whatever `queue` is still holding. */
  cancel: () => void
  /** Wipe the panel and the retained stream. Does not touch the machine. */
  clear: () => void
}

let shared: Console | undefined

function createConsole(): Console {
  const store = useEmulatorStore()
  const buffer = new TerminalBuffer()
  const revision = ref(0)

  store.onTransmit((byte) => {
    buffer.write(byte)
    revision.value = buffer.version
  })

  function clear(): void {
    buffer.clear()
    revision.value = buffer.version
  }

  /**
   * A new machine is a cold console.
   *
   * `store.init()` builds a new Machine when the Serial Card is fitted or
   * pulled, and leaving the old machine's output on screen underneath a fresh
   * boot would read as one session continuing.
   */
  watch(
    () => store.machine,
    (machine, previous) => {
      if (previous && machine !== previous) clear()
    }
  )

  function send(data: Uint8Array | number[] | number): void {
    const machine = store.machine
    if (!machine || !machine.acia()) return
    const bytes = typeof data === 'number' ? [data] : data
    for (const byte of bytes) machine.onReceive(byte & 0xff)
  }

  let cancelled = false

  async function queue(data: Uint8Array, baudRate = DEFAULT_SERIAL_CONFIG.baudRate): Promise<void> {
    if (!store.machine?.acia()) return
    cancelled = false

    const perTick = Math.max(1, Math.round((baudRate / BITS_PER_BYTE) * (TICK_MS / 1000)))

    for (let i = 0; i < data.length && !cancelled; i += perTick) {
      send(data.subarray(i, Math.min(i + perTick, data.length)))
      await sleep(TICK_MS)
    }
  }

  function cancel(): void {
    cancelled = true
  }

  return { buffer, revision, send, queue, cancel, clear }
}

export function useConsole(): Console {
  shared ??= createConsole()
  return shared
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
