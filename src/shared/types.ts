/**
 * Shared types and IPC channel constants used by the main, preload, and
 * renderer processes.
 */

import { DEFAULT_SERIAL_CARD } from './serialCard'
import type { SerialCardConfig } from '../core/IO/SerialCard'
import type { SerialLines } from '../core/SerialPeer'

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
  /**
   * @deprecated Since 1.2, ignored, and dropped in a later release. It was the
   * OS doing RTS/CTS on the host's port, on behalf of a machine it knew
   * nothing about.
   *
   * The port is the far end of the *emulated* machine's serial card, not a
   * terminal for a real board. It now opens with the OS's RTS/CTS off, and the
   * machine does the handshake itself: its RTS drives the port's RTS, and the
   * port's CTS, DCD and DSR reach the chip wherever the card's jumpers connect
   * them to the cable (`AppSettings.serialCardConfig`). The OS doing it as well
   * would fight the machine for the RTS line.
   *
   * Kept in the type, so a settings file that has it still loads; the version
   * 3 migration drops it from the file (see `SETTINGS_VERSION`).
   */
  rtscts?: boolean
}

/** Default matches the real machine's 19200 8-N-1 boot config. */
export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baudRate: 19200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1
}

export type SerialStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** A real port's CTS, DCD and DSR, as it last read them: true is asserted. */
export type SerialSignals = SerialLines

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
   * Which serial card io5 holds when one is fitted, and its jumpers
   * (`--serial-card`, `--cts`, `--dcd`). Not in a file written before 1.2,
   * which loads with `DEFAULT_SERIAL_CARD`: the Serial Card, `CTS EN` at
   * ground.
   *
   * Not `serialCard`, as 6502-EMULATOR has it: here `serialCardFitted` and
   * `session.info`'s `serialCard` already say whether there is one at all.
   */
  serialCardConfig: SerialCardConfig
  /**
   * Whether the far end honours the machine's RTS (`--peer-rts`, and the
   * older `--[no-]flow-control`): input from the terminal panel, its Paste box
   * and a host port waits while RTS is high. On by default, as a terminal set
   * up for the board is.
   *
   * Also holds bytes a real port has already delivered, which a device that
   * honours RTS itself sent before it saw RTS rise.
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
 *
 * 3 (1.2): the serial card's model and jumpers, `serialCardConfig`, arrived,
 * and the port's own `serialConfig.rtscts` went. A version 2 file keeps its
 * `flowControl`, loses `rtscts`, and gets the Serial Card with `CTS EN` at
 * ground: the machine it always had.
 */
export const SETTINGS_VERSION = 3

/**
 * There is no CPU frequency here. PHI2 on this board is 1 MHz, so there is
 * nothing to choose and nothing to remember.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  serialConfig: DEFAULT_SERIAL_CONFIG,
  serialCardFitted: true,
  serialCardConfig: DEFAULT_SERIAL_CARD,
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
  // The machine's RTS out to the port, and the port's CTS/DCD/DSR back in
  SERIAL_SET_RTS: 'serial:setRts',
  SERIAL_SIGNALS: 'serial:signals',
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
