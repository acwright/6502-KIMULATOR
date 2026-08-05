import type { Session } from '@debug/Session'
import { SymbolTable } from '@debug/symbols/Symbols'
import type { DebugTarget } from '@debug/server/DebugTarget'

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
 * The `serial.*` methods are deliberately absent for now and report
 * NOT_SUPPORTED. They need a buffered console with a stream cursor to read back
 * from, which is the Terminal panel's own state — it arrives in phase 5, and
 * wiring this to a second, invisible buffer in the meantime would mean a debug
 * client and the window disagreeing about what the machine has said.
 */
export class RendererTarget implements DebugTarget {
  readonly hostName = 'electron'
  readonly symbols = new SymbolTable()

  constructor(
    readonly session: Session,
    readonly version: string
  ) {}

  consoleMode(): 'serial' | 'keypad' {
    return this.session.machine.acia() ? 'serial' : 'keypad'
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
