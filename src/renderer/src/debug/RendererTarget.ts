import type { Session } from '@debug/Session'
import { SymbolTable } from '@debug/symbols/Symbols'
import type { DebugTarget, SerialRead } from '@debug/server/DebugTarget'
import type { Console } from '@/composables/useConsole'

/**
 * Presents the desktop app's own machine to the debug protocol.
 *
 * The Electron counterpart to the headless host's target — same interface, same
 * `createMethods()` table, different host. File reads proxy to main, which is
 * the only process with filesystem access.
 *
 * `consoleMode` is read off the machine rather than fixed: io5 is genuinely
 * toggleable here, and a KIM with no Serial Card has no serial console at all —
 * a configuration `KC Monitor.asm` supports, guarding every ACIA access on
 * `HW_PRESENT & HW_SC`. The pad and the LCD are still reachable through
 * `keypad.press` and `lcd.*` either way, because they are on the Keypad Card
 * rather than in a slot.
 *
 * The `serial.*` methods read and write the **Terminal panel's own buffer**,
 * which is the point: a debug client asking what the machine has said and the
 * window showing what it said are looking at one buffer, so they cannot
 * disagree. `serial.write` goes in through the same paced queue the Paste box
 * uses, so a scripted deposit arrives at the line rate rather than all at once.
 */
export class RendererTarget implements DebugTarget {
  readonly hostName = 'electron'
  readonly symbols = new SymbolTable()

  constructor(
    readonly session: Session,
    readonly version: string,
    private readonly console: Console
  ) {}

  consoleMode(): 'serial' | 'keypad' {
    return this.session.machine.acia() ? 'serial' : 'keypad'
  }

  writeSerial(data: Uint8Array): void {
    // Deliberately not awaited: the queue paces itself against the wall clock,
    // and `serial.write` answers with how much it accepted, not with how much
    // has landed. A client that needs to know waits on the cursor it was given.
    void this.console.queue(data)
  }

  readSerial(options: { since?: number; max?: number; clear?: boolean }): SerialRead {
    return this.console.buffer.read(options)
  }

  onSerial(callback: (text: string) => void): () => void {
    return this.console.buffer.onOutput((bytes) => {
      let text = ''
      for (const byte of bytes) text += String.fromCharCode(byte)
      callback(text)
    })
  }

  async readTextFile(path: string): Promise<string> {
    if (!window.api) throw new Error('no filesystem access outside the desktop app')
    return window.api.debug.readTextFile(path)
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    if (!window.api) throw new Error('no filesystem access outside the desktop app')
    return window.api.debug.readBinaryFile(path)
  }
}
