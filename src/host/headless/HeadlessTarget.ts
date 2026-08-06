import { readFileSync } from 'node:fs'
import type { Session } from '../../debug/Session'
import type { SymbolTable } from '../../debug/symbols/Symbols'
import type { DebugTarget, SerialRead } from '../../debug/server/DebugTarget'
import type { HeadlessHost } from './HeadlessHost'

/**
 * Presents a headless machine to the debug protocol.
 *
 * Thin on purpose. Everything with behaviour lives either in the host (which
 * knows how to run a machine) or in the method table (which knows the
 * protocol); this only says which of the host's capabilities exist, which is
 * exactly what changes between hosts.
 *
 * The `serial.*` group is that difference made concrete: on a machine with no
 * Serial Card there is no console at all, so those methods are left off rather
 * than wired to something that would accept bytes and drop them. The method
 * table answers NOT_SUPPORTED, which is a truthful thing for a client to hear
 * about a machine it can still drive from the pad.
 */
export class HeadlessTarget implements DebugTarget {
  readonly hostName = 'headless'

  readonly writeSerial?: (data: Uint8Array) => void
  readonly readSerial?: (options: { since?: number; max?: number; clear?: boolean }) => SerialRead
  readonly onSerial?: (callback: (text: string) => void) => () => void
  readonly baudRate?: () => number
  readonly setBaudRate?: (rate: number) => void

  private readonly releaseOutput: () => void

  constructor(
    private readonly host: HeadlessHost,
    readonly version: string
  ) {
    // Something is going to ask for `serial.read` or wait on output, and the
    // host does not retain it otherwise.
    this.releaseOutput = host.retainOutput()

    const serial = host.serial
    if (!serial) return

    this.writeSerial = (data) => host.write(data)
    this.readSerial = (options) => host.readOutput(options)
    this.onSerial = (callback) =>
      host.onSerialOutput((data) => {
        let text = ''
        for (const byte of data) text += String.fromCharCode(byte)
        callback(text)
      })
    this.baudRate = () => serial.baudRate
    this.setBaudRate = (rate) => {
      serial.baudRate = rate
    }
  }

  get session(): Session {
    return this.host.session
  }

  get symbols(): SymbolTable {
    return this.host.symbols
  }

  consoleMode(): 'serial' | 'keypad' {
    return this.host.consoleMode
  }

  readTextFile(path: string): string {
    return readFileSync(path, 'utf8')
  }

  readBinaryFile(path: string): Uint8Array {
    return new Uint8Array(readFileSync(path))
  }

  shutdown(): void {
    this.releaseOutput()
    this.host.stop('stopped')
  }
}
