/**
 * Shared types and IPC channel constants used by the main, preload, and
 * renderer processes.
 */

// ── Serial ───────────────────────────────────────────────────────────────────

export interface PortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
}

export interface SerialConfig {
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  parity: 'none' | 'odd' | 'even'
  stopBits: 1 | 1.5 | 2
}

/** Default matches the real machine's 19200 8-N-1 boot config. */
export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
}

export type SerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// ── ROMs ─────────────────────────────────────────────────────────────────────

/**
 * The two images a KIM boots from, as shipped in the app bundle.
 *
 * Two rather than one because the Keypad Card is not a cartridge — it carries
 * its own 8 KB ROM and its own vectors, and a machine holding only `BIOS.bin`
 * would reset into an address that is not on this bus. Either may come back
 * null: a build missing an image should say so and leave a machine you can
 * still look at, rather than refusing to open a window.
 */
export interface DefaultROMs {
  bios: Uint8Array | null
  card: Uint8Array | null
}

// ── Debug server ─────────────────────────────────────────────────────────────

export interface DebugServerStatus {
  running: boolean
  host?: string
  port?: number
  token?: string
  url?: string
}

export interface DebugStartOptions {
  port?: number
  host?: string
  requireToken?: boolean
  /** Use this token instead of generating one — `6502-kim run --debug-token`. */
  token?: string
}

/** Main → renderer: run this call against the local Session and reply. */
export interface DebugCallRequest {
  id: number
  method: string
  params: unknown
}

/** Renderer → main: the result of a DebugCallRequest. */
export interface DebugCallReply {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Renderer → main: a push notification (`stopped`, `resumed`, ...) to broadcast. */
export interface DebugEventMessage {
  method: string
  params?: unknown
}

// ── CLI shim ─────────────────────────────────────────────────────────────────

export interface CliShimStatus {
  installed: boolean
  /** Where the shim was written, when installed. */
  path?: string
  /** True when this platform's install step is handled by the installer, not this action. */
  managedByInstaller?: boolean
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  serialConfig: SerialConfig
  /**
   * Whether the Serial Card is in io5.
   *
   * Not decoration: `KC Monitor.asm` guards every ACIA access on
   * `HW_PRESENT & HW_SC`, so unfitting it is the only way to exercise the
   * keypad-only path the firmware explicitly supports.
   */
  serialCardFitted: boolean
  /**
   * The accessory wired to the bus at $9400, by its `id` in
   * `core/accessories/registry` — null for an empty bay, which is what a KIM is
   * without a breadboard plugged into it.
   *
   * An id this build does not recognise leaves io6 vacant rather than failing
   * the boot: a settings file written by a later version should give you a
   * machine you can still use.
   */
  accessory: string | null
  /**
   * RTS/CTS flow control on serial input (`--[no-]flow-control`): whether the
   * far end — the host port, the terminal panel's Paste box — honours RTS. On
   * by default, as a terminal set up for the board is.
   */
  flowControl: boolean
  /**
   * The version of this file's format, for one-off migrations when a default
   * changes. Missing in files written before 1.1; see `SETTINGS_VERSION`.
   */
  settingsVersion?: number
}

/**
 * The current `AppSettings.settingsVersion`.
 *
 * 2: flow control became on by default. Every save writes the whole settings
 * object, so 1.0.10 and 1.0.11 wrote `flowControl: false` as soon as anything
 * was changed, whether or not anyone chose it. A file without a version
 * therefore has its `flowControl` reset to the new default, once; the file then
 * carries version 2, and someone who turns flow control off afterwards keeps it
 * off.
 */
export const SETTINGS_VERSION = 2

/**
 * There is no CPU frequency here. PHI2 on this board is 1 MHz — the ACE is the
 * machine in the family with the 2 MHz jumper — so there is nothing to choose
 * and nothing to remember.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  serialConfig: DEFAULT_SERIAL_CONFIG,
  serialCardFitted: true,
  accessory: null,
  flowControl: true,
  settingsVersion: SETTINGS_VERSION
}

// ── IPC channels ─────────────────────────────────────────────────────────────

export const IPC = {
  // App / window
  APP_GET_VERSION: 'app:getVersion',
  WINDOW_TOGGLE_FULLSCREEN: 'window:toggleFullscreen',
  WINDOW_IS_FULLSCREEN: 'window:isFullscreen',
  WINDOW_FULLSCREEN_CHANGED: 'window:fullscreenChanged',
  // What `6502-kim run` asked this launch to boot with (see shared/boot.ts)
  BOOT_GET: 'boot:get',
  // Serial port
  SERIAL_LIST_PORTS: 'serial:listPorts',
  SERIAL_CONNECT: 'serial:connect',
  SERIAL_DISCONNECT: 'serial:disconnect',
  SERIAL_SEND: 'serial:send',
  SERIAL_DATA: 'serial:data',
  SERIAL_STATUS: 'serial:status',
  // The bundled BIOS and Keypad Card images
  ROMS_LOAD_DEFAULT: 'roms:loadDefault',
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  // Debug server — main hosts the socket, the renderer's Session actually
  // executes calls, so every RPC crosses this bridge twice.
  DEBUG_START: 'debug:start',
  DEBUG_STOP: 'debug:stop',
  DEBUG_STATUS: 'debug:status',
  DEBUG_STATUS_CHANGED: 'debug:statusChanged',
  DEBUG_CALL_REQUEST: 'debug:callRequest',
  DEBUG_CALL_REPLY: 'debug:callReply',
  DEBUG_EVENT: 'debug:event',
  DEBUG_READ_TEXT_FILE: 'debug:readTextFile',
  DEBUG_READ_BINARY_FILE: 'debug:readBinaryFile',
  // CLI shim
  CLI_STATUS: 'cli:status',
  CLI_INSTALL: 'cli:install',
  CLI_UNINSTALL: 'cli:uninstall',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
