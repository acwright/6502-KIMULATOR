import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/types'
import type {
  SerialConfig,
  SerialSignals,
  SerialStatus,
  AppSettings,
  PortInfo,
  DefaultROMs,
  DebugServerStatus,
  DebugStartOptions,
  DebugCallRequest,
  DebugCallReply
} from '../shared/types'
import type { BootPayload } from '../shared/boot'
import type { AppApi } from '../shared/api'

const api: AppApi = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION)
  },

  window: {
    toggleFullscreen: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_TOGGLE_FULLSCREEN),
    isFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_FULLSCREEN),
    onFullscreenChanged: (callback: (value: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, value: boolean): void => callback(value)
      ipcRenderer.on(IPC.WINDOW_FULLSCREEN_CHANGED, handler)
      return () => ipcRenderer.off(IPC.WINDOW_FULLSCREEN_CHANGED, handler)
    }
  },

  boot: {
    get: (): Promise<BootPayload | null> => ipcRenderer.invoke(IPC.BOOT_GET)
  },

  serial: {
    listPorts: (): Promise<PortInfo[]> =>
      ipcRenderer.invoke(IPC.SERIAL_LIST_PORTS),
    connect: (path: string, config: SerialConfig): Promise<void> =>
      ipcRenderer.invoke(IPC.SERIAL_CONNECT, path, config),
    disconnect: (): Promise<void> =>
      ipcRenderer.invoke(IPC.SERIAL_DISCONNECT),
    send: (data: Uint8Array): void => ipcRenderer.send(IPC.SERIAL_SEND, data),
    setRequestToSend: (asserted: boolean): void =>
      ipcRenderer.send(IPC.SERIAL_SET_RTS, asserted),
    onSignals: (callback: (signals: SerialSignals) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, signals: SerialSignals): void =>
        callback(signals)
      ipcRenderer.on(IPC.SERIAL_SIGNALS, handler)
      return () => ipcRenderer.off(IPC.SERIAL_SIGNALS, handler)
    },
    onData: (callback: (data: Uint8Array) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: Uint8Array): void => callback(data)
      ipcRenderer.on(IPC.SERIAL_DATA, handler)
      return () => ipcRenderer.off(IPC.SERIAL_DATA, handler)
    },
    onStatus: (callback: (status: SerialStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: SerialStatus): void =>
        callback(status)
      ipcRenderer.on(IPC.SERIAL_STATUS, handler)
      return () => ipcRenderer.off(IPC.SERIAL_STATUS, handler)
    }
  },

  roms: {
    loadDefaults: (): Promise<DefaultROMs> => ipcRenderer.invoke(IPC.ROMS_LOAD_DEFAULT)
  },

  settings: {
    get: (): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (partial: Partial<AppSettings>): Promise<void> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, partial)
  },

  debug: {
    start: (options?: DebugStartOptions): Promise<DebugServerStatus> =>
      ipcRenderer.invoke(IPC.DEBUG_START, options),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_STOP),
    status: (): Promise<DebugServerStatus> => ipcRenderer.invoke(IPC.DEBUG_STATUS),
    onStatusChanged: (callback: (status: DebugServerStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: DebugServerStatus): void =>
        callback(status)
      ipcRenderer.on(IPC.DEBUG_STATUS_CHANGED, handler)
      return () => ipcRenderer.off(IPC.DEBUG_STATUS_CHANGED, handler)
    },
    // Bidirectional over one-directional IPC primitives: main can only `send`
    // into the renderer and get a reply by listening for a second message, so
    // that request/reply correlation lives here rather than being reinvented
    // by every caller of onCall(). The callback returns plain data rather than
    // throwing — see AppApi.debug.onCall — so nothing here needs to guess at
    // how an exception would serialise across the isolated-world boundary.
    onCall: (
      callback: (
        method: string,
        params: unknown
      ) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>
    ): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, request: DebugCallRequest): void => {
        void callback(request.method, request.params)
          .then(({ result, error }) => {
            const reply: DebugCallReply = { id: request.id, ...(error ? { error } : { result }) }
            ipcRenderer.send(IPC.DEBUG_CALL_REPLY, reply)
          })
          .catch((e: unknown) => {
            // The renderer's contract is to never throw; this is a bug in the
            // bridge itself, not an RPC error, and still needs an answer or
            // main's pending call would hang until its timeout.
            ipcRenderer.send(IPC.DEBUG_CALL_REPLY, {
              id: request.id,
              error: { code: -32603, message: `debug bridge: ${String(e)}` }
            } satisfies DebugCallReply)
          })
      }
      ipcRenderer.on(IPC.DEBUG_CALL_REQUEST, handler)
      return () => ipcRenderer.off(IPC.DEBUG_CALL_REQUEST, handler)
    },
    emitEvent: (method: string, params?: unknown): void =>
      ipcRenderer.send(IPC.DEBUG_EVENT, { method, params }),
    readTextFile: (path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.DEBUG_READ_TEXT_FILE, path),
    readBinaryFile: (path: string): Promise<Uint8Array> =>
      ipcRenderer.invoke(IPC.DEBUG_READ_BINARY_FILE, path)
  },

  cli: {
    status: () => ipcRenderer.invoke(IPC.CLI_STATUS),
    install: () => ipcRenderer.invoke(IPC.CLI_INSTALL),
    uninstall: () => ipcRenderer.invoke(IPC.CLI_UNINSTALL)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
