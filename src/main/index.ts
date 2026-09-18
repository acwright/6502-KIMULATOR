import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '../shared/types'
import type {
  SerialConfig,
  AppSettings,
  DebugCallReply,
  DebugEventMessage,
  DebugStartOptions
} from '../shared/types'
import type { BootPayload } from '../shared/boot'
import { SerialService } from './serial'
import { RomService } from './roms'
import { SettingsService } from './settings'
import { DebugBridgeService } from './debugBridge'
import { CliShimService } from './cliShim'
import { bootConfigFrom, readBootPayload } from './boot'
import { userDataPath } from './userData'

// Settings stay in the folder every release up to 1.0.10 used, although the
// app's name no longer says 6502-kimulator. Before `ready`, before any service
// asks for it. See userData.ts.
app.setPath('userData', userDataPath(app.getPath('appData')))

// ── Singletons ───────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let serialService: SerialService
let romService: RomService
let settingsService: SettingsService
let debugBridge: DebugBridgeService
let cliShim: CliShimService

// What `6502-kim run` asked this launch to boot with, if it launched us at all.
// Read before `ready` so the window can be created knowing about it.
const boot = bootConfigFrom(process.argv)
let bootPayload: Promise<BootPayload> | undefined

// ── Window ───────────────────────────────────────────────────────────────────

// A KIM has no video card, so nothing here dictates an aspect ratio the way the
// ACE's 320×240 VDP did. The window is a terminal beside an LCD and a keypad,
// each of which keeps its own proportions inside a resizable grid — so this is
// a comfortable default and a floor below which the pad stops being legible,
// not a fixed frame.
const BASE_WIDTH = 1180
const BASE_HEIGHT = 800
const MIN_WIDTH = 800
const MIN_HEIGHT = 560

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    fullscreenable: true,
    center: true,
    title: 'AC6502 KIMulator',
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden renderer is throttled hard — measured here, setTimeout(0) goes
      // from ~186/s to 2.6/s. Scheduler paces the machine with setTimeout (no
      // setImmediate in the renderer), so that is not a slower app: it is a
      // 1 MHz KIM running at a few cycles a second whenever it is not in front.
      backgroundThrottling: false,
      // Required for serialport's native Node.js bindings.
      sandbox: false
    }
  })

  serialService.setWindow(mainWindow)
  debugBridge.setWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (boot?.fullscreen) mainWindow?.setFullScreen(true)
    // Launched from a terminal, the window is the thing the user just asked
    // for — it belongs in front of the shell they typed into.
    if (boot) app.focus({ steal: true })
  })

  // Fullscreen state → renderer
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGED, true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send(IPC.WINDOW_FULLSCREEN_CHANGED, false)
  })

  // The ACE intercepted this close to give the renderer time to write its CF
  // card and NVRAM out. A KIM has neither — it loses its RAM when you switch it
  // off, exactly as the real one does — so the window closes immediately and
  // the only thing owed anyone is an answer: a debug client mid-call against a
  // renderer about to be torn down would otherwise hang until its own timeout.
  mainWindow.on('close', () => {
    void debugBridge.stop()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.acwright.kimulator6502')

  app.on('browser-window-created', (_, win) => {
    optimizer.watchWindowShortcuts(win)
  })

  // Instantiate services (requires app to be ready for getPath).
  serialService = new SerialService()
  romService = new RomService()
  settingsService = new SettingsService()
  debugBridge = new DebugBridgeService()
  cliShim = new CliShimService()

  // Anything `6502-kim run` set on the command line stands in for the saved
  // value for this launch, so everything below reads one settled set of settings.
  if (boot?.settings) settingsService.override(boot.settings)

  // ── App / window IPC ───────────────────────────────────────────────────────

  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion())

  ipcMain.handle(IPC.WINDOW_TOGGLE_FULLSCREEN, () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })

  ipcMain.handle(IPC.WINDOW_IS_FULLSCREEN, () => mainWindow?.isFullScreen() ?? false)

  // ── Boot config (`6502-kim run` with a window) ─────────────────────────────

  // Read once and remembered: a reload of the renderer gets the same machine
  // it was launched with rather than a bare one.
  ipcMain.handle(IPC.BOOT_GET, () => {
    if (!boot) return null
    bootPayload ??= readBootPayload(boot)
    return bootPayload
  })

  // ── Serial IPC ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SERIAL_LIST_PORTS, () => serialService.listPorts())

  ipcMain.handle(IPC.SERIAL_CONNECT, async (_e, path: string, config: SerialConfig) => {
    if (!mainWindow) throw new Error('No main window')
    serialService.setWindow(mainWindow)
    return serialService.connect(path, config)
  })

  ipcMain.handle(IPC.SERIAL_DISCONNECT, () => serialService.disconnect())

  // Fire-and-forget (ipcMain.on not handle) for low-latency serial TX.
  ipcMain.on(IPC.SERIAL_SEND, (_e, data: Uint8Array) => serialService.send(data))
  ipcMain.on(IPC.SERIAL_SET_RTS, (_e, asserted: boolean) => serialService.setRequestToSend(asserted))

  // ── ROM IPC ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ROMS_LOAD_DEFAULT, () => romService.loadDefaults())

  // ── Settings IPC ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET, () => settingsService.get())

  ipcMain.handle(IPC.SETTINGS_SET, (_e, partial: Partial<AppSettings>) => {
    settingsService.set(partial)
  })

  // ── Debug server IPC ───────────────────────────────────────────────────────

  const broadcastDebugStatus = (): void => {
    mainWindow?.webContents.send(IPC.DEBUG_STATUS_CHANGED, debugBridge.status())
  }

  ipcMain.handle(IPC.DEBUG_START, async (_e, options?: DebugStartOptions) => {
    const status = await debugBridge.start(options)
    broadcastDebugStatus()
    return status
  })

  ipcMain.handle(IPC.DEBUG_STOP, async () => {
    await debugBridge.stop()
    broadcastDebugStatus()
  })

  ipcMain.handle(IPC.DEBUG_STATUS, () => debugBridge.status())

  // Fire-and-forget (ipcMain.on not handle): these are one-way, main→renderer
  // requests already got their answer, and the renderer expects no reply.
  ipcMain.on(IPC.DEBUG_CALL_REPLY, (_e, reply: DebugCallReply) => debugBridge.handleReply(reply))
  ipcMain.on(IPC.DEBUG_EVENT, (_e, event: DebugEventMessage) => debugBridge.handleEvent(event))

  // The renderer has no filesystem of its own; `sym.load` and the ROM-loading
  // methods reach one through here when driven by a debug client.
  ipcMain.handle(IPC.DEBUG_READ_TEXT_FILE, (_e, path: string) => readFile(path, 'utf8'))
  ipcMain.handle(IPC.DEBUG_READ_BINARY_FILE, async (_e, path: string) => new Uint8Array(await readFile(path)))

  // ── CLI shim IPC ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.CLI_STATUS, () => cliShim.status())
  ipcMain.handle(IPC.CLI_INSTALL, () => cliShim.install())
  ipcMain.handle(IPC.CLI_UNINSTALL, () => cliShim.uninstall())

  // ── Start ──────────────────────────────────────────────────────────────────

  createWindow()

  // `6502-kim run --debug`: serve from launch, so a debugger has something to
  // attach to before the firmware has run an instruction (with --pause it does).
  if (boot?.debug) {
    try {
      const status = await debugBridge.start(boot.debug)
      broadcastDebugStatus()
      process.stderr.write(`6502-kim: debug server on ${status.url}\n`)
    } catch (e) {
      process.stderr.write(`6502-kim: could not start the debug server: ${(e as Error).message}\n`)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Quit on all platforms. The user expects closing the window to exit the app.
  app.quit()
})
