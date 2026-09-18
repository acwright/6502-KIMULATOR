import type { PortInfo, SerialConfig, SerialSignals, SerialStatus } from '@shared/types'

export interface ISerialService {
  /** Whether this service can connect to serial ports on the current platform. */
  isAvailable(): boolean
  /** Electron: list detected ports. Web: always returns []. */
  listPorts(): Promise<PortInfo[]>
  /**
   * Open a connection.
   * - Web path: ignores `portPath`, triggers browser's port-picker dialog.
   * - Electron path: `portPath` is required (supplied by the port-picker UI).
   */
  connect(config: SerialConfig, portPath?: string): Promise<void>
  disconnect(): Promise<void>
  /** Send raw bytes to the connected port. */
  send(data: Uint8Array): void
  /** Subscribe to incoming data bytes. Returns an unsubscribe function. */
  onData(cb: (data: Uint8Array) => void): () => void
  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onStatus(cb: (status: SerialStatus) => void): () => void
  /** Drive the port's RTS line: true is asserted. */
  setRequestToSend(asserted: boolean): void
  /**
   * Subscribe to the port's CTS, DCD and DSR: once they are first read after
   * connecting, and each time they change. Returns an unsubscribe function.
   */
  onSignals(cb: (signals: SerialSignals) => void): () => void
}
