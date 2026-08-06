import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { HeadlessHost, readROM, readCardROM } from '../host/headless/HeadlessHost'
import type { RunResult, BinaryLoad } from '../host/headless/HeadlessHost'
import { HeadlessTarget } from '../host/headless/HeadlessTarget'
import { DebugServer } from '../debug/server/DebugServer'
import { createMethods } from '../debug/server/Methods'
import { cliVersion } from './version'
import { buildBootConfig, launchApp } from './app'
import { parseSymbols, formatForPath } from '../debug/symbols/parse'
import { formatLCD } from './dbg/format'
import { UsageError, parseAccessory, parseBinarySpec, parseCount, parseDuration } from './args'

export const RUN_HELP = `Usage: 6502-kim run [options]

Boot a KIM, optionally loaded with your build output. Opens the desktop app with
everything already attached; --headless runs without a window instead, with the
serial console wired to stdin and stdout.

Machine
  --rom <file>              Use this BIOS instead of the bundled one (32 KB)
  --card-rom <file>         Use this Keypad Card ROM instead of the bundled
                            KC Monitor (8 KB) — for testing a fresh build of the
                            firmware without burning an AT28C64
  --bin <addr>=<file>       Load raw bytes at an address (repeatable)
  --accessory <id>          Wire a circuit to the accessory bus at $9400
  --no-serial-card          Leave io5 vacant. HW_PRESENT comes back without
                            HW_SC and the KC Monitor takes its keypad-only path,
                            which is a machine the firmware supports and the only
                            way to exercise that path
  --baud <rate>             Serial rate: the ACIA headless, the host port in the app

Execution
  --pause                   Start paused, for attaching a debugger before boot

Window (the default)
  --fullscreen              Open fullscreen
  --detach                  Return to the shell instead of waiting for the window
  --serial <port>           Connect the ACIA to this host serial port at launch
  --serial-config <8N1>     Framing for that port (default: 8N1)
  --app <path>              The desktop app to launch, if it can't be found

Headless (--headless)
  --realtime                Pace against the wall clock instead of running flat out
  --max-cycles <n>          Stop after n CPU cycles
  --timeout <duration>      Stop after 30s, 500ms, 5m ...
  --exit-on <regex>         Stop when serial output matches
  --input-after <regex>     Hold stdin until serial output matches
  --lcd                     Print the 16x2 panel to stderr whenever it changes
  --json                    Print a machine-readable result to stderr on exit

Debugging
  --debug                   Serve the debug protocol (JSON-RPC over WS and HTTP)
  --debug-port <n>          Port to listen on (default: an unused one)
  --debug-host <addr>       Interface to bind (default: 127.0.0.1)
  --debug-token <token>     Use this token instead of generating one
  --symbols <file>          Load a VICE label file, a ca65 .dbg, or KC Monitor.lst

Output
  --quiet                   Suppress the startup banner

Exit codes
  0  ran to completion       2  timed out
  1  usage or load error     130 interrupted

Notes
  A windowed run does not return until the window closes, which is what makes
  it usable as a build step: assemble, look at it, close it, back to the shell.
  --detach hands the terminal back at once instead.

  There is no --cart and no program argument. The Keypad Card is this machine's
  cartridge and it is soldered in; a type-in card is bytes at an address, which
  is --bin. --card-rom replaces the card's own firmware and is a different thing
  entirely from slotting one in.

  There is no --freq either. PHI2 on this board is 1 MHz — the ACE is the family
  member with the 2 MHz jumper — so there is nothing to choose.

  --baud, --serial-config, --accessory and --no-serial-card set what the app's
  Settings panel sets, for that launch only: they show up in the panel, and
  nothing is written to your saved settings.

  The app the CLI launches is the one that installed it — the shim runs this
  command inside the app's own Electron, so the two can never be different
  versions. From a checkout it launches the build in out/, and --app or
  SIXTY5O2_KIM_APP override both.

  Every headless run is already reproducible: nothing in this machine reads the
  host clock, so the same ROMs, the same input and the same cycle budget produce
  byte-identical results on every run and every machine. (6502-EMULATOR needs
  --rtc for this; a KIM has no clock card to pin.)

  A keypad-only machine (--no-serial-card) has no console at all. Drive it with
  --debug and keypad.press, and read it back with lcd.text or --lcd.

Examples
  # Cross-development: build, then key it in on a real-looking pad.
  6502-kim run --bin 0x0800=build/counter.bin --accessory led-latch

  # Same machine, no window, for a script or an agent.
  6502-kim run --headless --bin 0x0800=build/counter.bin --max-cycles 5e6

  # The KC Monitor's serial monitor on a TTY: deposit and run, Wozmon syntax.
  printf '0200: A9 41 20 EF FF 00\\r0200R\\r' | 6502-kim run --headless --timeout 10s

  # Watch the glass while a program runs, with no serial console at all.
  6502-kim run --headless --no-serial-card --lcd --max-cycles 5e6

  # Serve a debugger, paused at reset, with the monitor's symbols — either way.
  6502-kim run --headless --debug --pause --symbols "KC Monitor.lst"
  6502-kim run --debug --pause --symbols build/game.lbl
`

const OPTIONS = {
  rom: { type: 'string' },
  'card-rom': { type: 'string' },
  bin: { type: 'string', multiple: true },
  accessory: { type: 'string' },
  'no-serial-card': { type: 'boolean' },
  baud: { type: 'string' },
  serial: { type: 'string' },
  'serial-config': { type: 'string' },
  headless: { type: 'boolean' },
  realtime: { type: 'boolean' },
  pause: { type: 'boolean' },
  'max-cycles': { type: 'string' },
  timeout: { type: 'string' },
  'exit-on': { type: 'string' },
  'input-after': { type: 'string' },
  lcd: { type: 'boolean' },
  debug: { type: 'boolean' },
  'debug-port': { type: 'string' },
  'debug-host': { type: 'string' },
  'debug-token': { type: 'string' },
  symbols: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean' },
  detach: { type: 'boolean' },
  fullscreen: { type: 'boolean' },
  app: { type: 'string' },
  help: { type: 'boolean', short: 'h' }
} as const

/**
 * Where the bundled firmware lives.
 *
 * Two images rather than one, because the Keypad Card carries its own: a
 * machine holding only `BIOS.bin` resets through a vector that is not on this
 * bus. `resourcesPath` exists only under Electron, which is how the installed
 * shim runs this; from a checkout we walk up to the repo's assets/.
 */
function bundledROMPath(file: 'BIOS.bin' | 'KCMonitor.bin', flag: string): string {
  const here = __dirname
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const candidates = [
    resources ? join(resources, 'assets', 'roms', file) : '',
    join(here, '..', '..', 'assets', 'roms', file),
    join(here, '..', '..', '..', 'assets', 'roms', file)
  ]
  const found = candidates.find((path) => path && existsSync(path))
  if (!found) {
    throw new UsageError(`could not find the bundled ${file}; pass one with ${flag}`)
  }
  return found
}

function readFile(path: string, label: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    throw new UsageError(`${label}: cannot read "${path}"`)
  }
}

export async function runCommand(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(RUN_HELP)
    return 0
  }

  // Windowed is the default: someone cross-developing wants to see the thing
  // run. Everything below this point is the machine that runs in this process.
  if (!values.headless) {
    return launchApp(buildBootConfig(values, positionals), {
      ...(values.detach ? { detach: true } : {}),
      ...(values.quiet ? { quiet: true } : {}),
      ...(values.app ? { app: values.app } : {})
    })
  }

  const windowOnly = (['detach', 'fullscreen', 'app', 'serial', 'serial-config'] as const).filter(
    (flag) => values[flag] !== undefined
  )
  if (windowOnly.length > 0) {
    throw new UsageError(
      `${windowOnly.map((flag) => `--${flag}`).join(', ')}: only applies to the app's window ` +
        '— a headless machine has no window and no host serial port'
    )
  }

  if (positionals.length > 0) {
    throw new UsageError(
      `unexpected argument "${positionals[0]}" — a KIM loads bytes at an address, ` +
        'so use --bin <addr>=<file>'
    )
  }

  const serialCard = !values['no-serial-card']

  // Both of these match against serial output, and a machine with no Serial
  // Card produces none. Accepting them would mean a run that can only ever end
  // on its timeout, reporting exit 2 for a program that did nothing wrong.
  const needsConsole = (['exit-on', 'input-after'] as const).filter(
    (flag) => values[flag] !== undefined
  )
  if (!serialCard && needsConsole.length > 0) {
    throw new UsageError(
      `${needsConsole.map((flag) => `--${flag}`).join(', ')}: there is no serial output to match ` +
        'on a machine with no Serial Card — drop --no-serial-card, or end the run with ' +
        '--max-cycles or --timeout'
    )
  }

  const binaries: BinaryLoad[] = (values.bin ?? []).map((spec) => {
    const { address, path } = parseBinarySpec(spec)
    return { address, bytes: readFile(path, '--bin') }
  })

  const compile = (flag: '--exit-on' | '--input-after', pattern?: string): RegExp | undefined => {
    if (pattern === undefined) return undefined
    try {
      return new RegExp(pattern)
    } catch (e) {
      throw new UsageError(`${flag}: ${(e as Error).message}`)
    }
  }
  const exitOn = compile('--exit-on', values['exit-on'])
  const inputAfter = compile('--input-after', values['input-after'])

  const host = new HeadlessHost({
    rom: values.rom ? readROM(values.rom) : readROM(bundledROMPath('BIOS.bin', '--rom')),
    cardROM: values['card-rom']
      ? readCardROM(values['card-rom'])
      : readCardROM(bundledROMPath('KCMonitor.bin', '--card-rom')),
    binaries,
    serialCard,
    ...(values.accessory !== undefined ? { accessory: parseAccessory(values.accessory) } : {}),
    baudRate: values.baud ? parseCount(values.baud, '--baud') : undefined,
    maxCycles: values['max-cycles'] ? parseCount(values['max-cycles'], '--max-cycles') : undefined,
    timeoutMs: values.timeout ? parseDuration(values.timeout, '--timeout') : undefined,
    exitOn,
    inputAfter,
    onOutput: (data) => process.stdout.write(data),
    // stderr, not stdout: stdout is the machine's serial stream and belongs to
    // it, so a piped run still sees exactly what the ACIA sent.
    ...(values.lcd ? { onLCD: (lines: string[]) => process.stderr.write(`${formatLCD(lines)}\n`) } : {})
  })

  if (!values.quiet) {
    // Say which way the machine can be talked to. A keypad-only boot behaves
    // differently — the KC Monitor skips every ACIA access — and nobody should
    // have to discover that by debugging a console that never answers.
    process.stderr.write(
      `6502-kim: headless, ${host.consoleMode} console, ` +
        `${(host.session.machine.frequency / 1e6).toFixed(0)} MHz` +
        `${values.accessory ? `, ${values.accessory}` : ''}` +
        `${values.realtime ? '' : ', turbo'}\n`
    )
  }

  if (values.symbols) {
    const path = values.symbols
    const table = parseSymbols(readFileSync(path, 'utf8'), formatForPath(path), path)
    host.symbols.merge(table)
    host.session.symbolResolver = (name) => host.symbols.resolve(name)
    if (!values.quiet) {
      process.stderr.write(`6502-kim: loaded ${table.size} symbols from ${path}\n`)
    }
  }

  const server = values.debug ? await startDebugServer(host, values) : undefined
  if (server && !values.quiet) {
    process.stderr.write(`6502-kim: debug server on ${server.url}\n`)
  }

  const detach = attachStdin(host)
  const onSignal = (): void => host.stop('stopped')
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let result: RunResult
  try {
    // --pause is how a debugger attaches before the firmware has run an
    // instruction. The run promise stays pending until a client calls exec.run,
    // and only then can an exit condition fire.
    result = await host.run(values.realtime ? 'realtime' : 'turbo', values.pause)
  } finally {
    detach()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await server?.close()
  }

  if (values.json) {
    process.stderr.write(`${JSON.stringify(result)}\n`)
  }

  if (result.reason === 'timeout') return 2
  if (result.reason === 'stopped') return 130
  return 0
}

interface DebugFlags {
  'debug-port'?: string
  'debug-host'?: string
  'debug-token'?: string
  quiet?: boolean
}

/**
 * Start serving the debug protocol for this machine.
 *
 * The port and token land in `~/.6502-kim/session.json`, which is what lets a
 * later `6502-kim dbg regs` find this process with no arguments at all.
 */
async function startDebugServer(
  host: HeadlessHost,
  values: DebugFlags
): Promise<{ url: string; close: () => Promise<void> }> {
  const bind = values['debug-host'] ?? '127.0.0.1'
  const exposed = bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost'

  if (exposed && !values.quiet) {
    process.stderr.write(
      `6502-kim: warning: --debug-host ${bind} exposes the machine beyond this computer; ` +
        'clients must present the token, which is in ~/.6502-kim/session.json\n'
    )
  }

  const target = new HeadlessTarget(host, cliVersion())
  const methods = createMethods(target)

  const server = new DebugServer({
    hostName: target.hostName,
    version: target.version,
    hostKind: 'headless',
    methods,
    onEvent: (callback) => subscribeHeadlessEvents(target, callback),
    host: bind,
    ...(values['debug-port'] ? { port: parseCount(values['debug-port'], '--debug-port') } : {}),
    ...(values['debug-token'] ? { token: values['debug-token'] } : {}),
    onLog: (message) => process.stderr.write(`6502-kim: ${message}\n`)
  })

  const listening = await server.listen()
  return { url: listening.url, close: () => server.close() }
}

/**
 * Forward a target's session and console events to the server's broadcaster.
 *
 * Serial output arrives a byte at a time from the ACIA; coalescing to the end
 * of the turn turns a 40-character line from 40 WebSocket frames into one.
 */
function subscribeHeadlessEvents(
  target: HeadlessTarget,
  callback: (method: string, params: unknown) => void
): () => void {
  const offs = [
    target.session.onStop((reason) => callback('stopped', { stop: reason })),
    target.session.onResume((mode) => callback('resumed', { mode }))
  ]

  let pending = ''
  let flushScheduled = false

  if (target.onSerial) {
    offs.push(
      target.onSerial((text) => {
        pending += text
        if (flushScheduled) return
        flushScheduled = true
        setImmediate(() => {
          flushScheduled = false
          const data = pending
          pending = ''
          if (data) callback('serial.data', { data })
        })
      })
    )
  }

  return () => {
    for (const off of offs) off()
  }
}

/**
 * Feed stdin to the machine's console.
 *
 * A TTY goes into raw mode so keystrokes reach the machine as they are typed
 * rather than a line at a time — the emulator, not the terminal, is doing the
 * line editing. A pipe just streams.
 *
 * Not attached at all on a keypad-only machine: there is nowhere for the bytes
 * to go, and resuming stdin would hold the process open after the run ended.
 */
function attachStdin(host: HeadlessHost): () => void {
  if (!host.serial) return () => {}

  const stdin = process.stdin
  if (stdin.isTTY) stdin.setRawMode?.(true)

  const onData = (chunk: Buffer): void => {
    // Ctrl-C never reaches the signal handler in raw mode; honour it here.
    if (stdin.isTTY && chunk.includes(0x03)) {
      host.stop('stopped')
      return
    }
    host.write(toSerialNewlines(chunk))
  }

  stdin.on('data', onData)
  stdin.resume()

  return () => {
    stdin.off('data', onData)
    if (stdin.isTTY) stdin.setRawMode?.(false)
    stdin.pause()
  }
}

/**
 * Translate host line endings to what a serial terminal sends.
 *
 * Pressing Enter on a terminal transmits CR, and the KC Monitor reads a line
 * until it sees one — an LF is accepted as input but never ends the line, so a
 * piped `echo '0200'` would be typed at the prompt and simply sit there. CRLF
 * collapses to a single CR so a Windows-authored script does not submit twice.
 */
function toSerialNewlines(chunk: Buffer): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < chunk.length; i++) {
    const byte = chunk[i]!
    if (byte === 0x0d && chunk[i + 1] === 0x0a) continue // CR of a CRLF pair
    out.push(byte === 0x0a ? 0x0d : byte)
  }
  return Uint8Array.from(out)
}
