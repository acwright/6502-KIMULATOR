import type {
  PortInfo,
  SerialConfig,
  SerialStatus,
  AppSettings,
  DefaultROMs,
  DebugServerStatus,
  DebugStartOptions,
  CliShimStatus
} from './types'
import type { BootPayload } from './boot'

/**
 * Public API surface exposed by the Electron preload to the renderer via
 * contextBridge. The same interface is used by the renderer's service layer to
 * type `window.api`, allowing TypeScript to verify both sides of the bridge.
 */
export interface AppApi {
  app: {
    getVersion(): Promise<string>
  }
  window: {
    toggleFullscreen(): Promise<void>
    isFullscreen(): Promise<boolean>
    onFullscreenChanged(callback: (value: boolean) => void): () => void
  }
  boot: {
    /**
     * The media and settings `6502-kim run` launched this window with — null
     * when the app was opened any other way. Main has already read the files.
     */
    get(): Promise<BootPayload | null>
  }
  serial: {
    listPorts(): Promise<PortInfo[]>
    connect(path: string, config: SerialConfig): Promise<void>
    disconnect(): Promise<void>
    /** Send bytes to the connected port. Fire-and-forget for performance. */
    send(data: Uint8Array): void
    onData(callback: (data: Uint8Array) => void): () => void
    onStatus(callback: (status: SerialStatus) => void): () => void
  }
  roms: {
    /** The bundled BIOS and Keypad Card images, read from the app bundle. */
    loadDefaults(): Promise<DefaultROMs>
  }
  settings: {
    get(): Promise<AppSettings>
    set(partial: Partial<AppSettings>): Promise<void>
  }
  debug: {
    start(options?: DebugStartOptions): Promise<DebugServerStatus>
    stop(): Promise<void>
    status(): Promise<DebugServerStatus>
    onStatusChanged(callback: (status: DebugServerStatus) => void): () => void
    /**
     * Register the renderer's method dispatcher.
     *
     * Main hosts the socket but has no Session of its own — every RPC request
     * main receives is forwarded here. The callback returns a plain
     * result-or-error object rather than throwing: thrown values cross the
     * preload context-isolation boundary as generic Errors, losing the
     * `RpcMethodError` code a client depends on, so the renderer catches its
     * own errors and hands back data instead. Only one registration is
     * meaningful at a time; a second call replaces the first.
     */
    onCall(
      callback: (
        method: string,
        params: unknown
      ) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>
    ): () => void
    /** Push a notification — `stopped`, `resumed` — for main to broadcast. */
    emitEvent(method: string, params?: unknown): void
    /** Proxies to the main process, which has the filesystem access the renderer lacks. */
    readTextFile(path: string): Promise<string>
    readBinaryFile(path: string): Promise<Uint8Array>
  }
  cli: {
    status(): Promise<CliShimStatus>
    install(): Promise<{ ok: boolean; message: string }>
    uninstall(): Promise<{ ok: boolean; message: string }>
  }
}
