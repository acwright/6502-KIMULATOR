import { useConsole } from '@/composables/useConsole'
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
 * The pacing and the machine itself live in `useConsole` — one input path, so
 * text pasted here and a `serial.write` from a debug client cannot arrive by
 * two different routes at two different rates.
 *
 * A machine with io5 vacant has nowhere for this to go and `injectText` does
 * nothing — the keypad-only path is real hardware, not an error to report.
 */
export function usePaste() {
  const console = useConsole()

  /**
   * Feed `text` to the machine's ACIA, paced at the configured line rate.
   * Resolves once the whole string has been delivered (or cancel() is called).
   */
  async function injectText(
    text: string,
    baudRate = DEFAULT_SERIAL_CONFIG.baudRate
  ): Promise<void> {
    await console.queue(new TextEncoder().encode(text), baudRate)
  }

  return { injectText, cancel: console.cancel }
}
