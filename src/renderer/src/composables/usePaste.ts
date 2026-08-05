import { useEmulatorStore } from '@/stores/emulator'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'

/**
 * Type text into the machine down the serial line.
 *
 * The ACE pasted by synthesising key presses on its matrix keyboard. A KIM has
 * no such keyboard — it has 24 keys and a serial port — so this goes in as
 * bytes arriving at the ACIA, exactly as if they had been typed at the other
 * end of the cable. Which means it accepts anything the KC Monitor's serial
 * monitor accepts, `bin2woz` output included: that is just Wozmon deposit
 * lines, and the machine cannot tell them from someone typing quickly.
 *
 * A machine with io5 vacant has nowhere for this to go and `injectText` does
 * nothing — the keypad-only path is real hardware, not an error to report.
 */

/** 8-N-1 puts a start and a stop bit around each byte: ten bits per character. */
const BITS_PER_BYTE = 10

/**
 * How often bytes are handed over. The ACIA queues what it is given and delivers
 * one byte per cycle as the firmware reads them, so this is about not running
 * ahead of the line rate rather than about overrun — a 20 ms tick at 19200 baud
 * is ~38 bytes, which is a plausible burst and a granularity nobody can see.
 */
const TICK_MS = 20

export function usePaste() {
  const store = useEmulatorStore()

  let cancelled = false

  /**
   * Feed `text` to the machine's ACIA, paced at the configured line rate.
   * Resolves once the whole string has been delivered (or cancel() is called).
   */
  async function injectText(text: string, baudRate = DEFAULT_SERIAL_CONFIG.baudRate): Promise<void> {
    const machine = store.machine
    if (!machine || !machine.acia()) return
    cancelled = false

    const bytes = new TextEncoder().encode(text)
    const perTick = Math.max(1, Math.round((baudRate / BITS_PER_BYTE) * (TICK_MS / 1000)))

    for (let i = 0; i < bytes.length && !cancelled; i += perTick) {
      for (let j = i; j < Math.min(i + perTick, bytes.length); j++) {
        machine.onReceive(bytes[j]!)
      }
      await sleep(TICK_MS)
    }
  }

  function cancel() {
    cancelled = true
  }

  return { injectText, cancel }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
