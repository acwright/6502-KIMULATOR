import { resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError, parseAddress, parseByte, parseCount, parseCursor, parseDuration } from '../args'
import { resolveTarget, httpCall, RpcClientError } from './Connection'
import { ExitCode } from './ExitCode'
import { unescape, parseByteList } from './text'
import {
  formatBreakpoint,
  formatBreakpoints,
  formatDisasm,
  formatKeypad,
  formatLCD,
  formatLCDPixels,
  formatRegisters,
  formatStop,
  formatSymbols,
  hexDump
} from './format'

/**
 * Every command in one file, in the shape `6502-kim dbg <this file's name>`.
 *
 * Grouped by protocol family and ordered to match DEBUG-PROTOCOL.md, so the
 * method a command calls is always the next thing below its heading.
 *
 * Three of 6502-EMULATOR's families are not here, because the hardware they
 * drove is not on this machine: `screen` (the video card — `lcd` stands where
 * it did), `input` (the matrix keyboard and the joysticks — `key` stands where
 * they did, and presses one thing because the 74C922 reports one thing), and
 * `unload cart`, since the Keypad Card is soldered in and there is no state in
 * which it is absent.
 */

/** Options every command accepts, whatever else it needs. */
const COMMON_OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
} as const

type CommonValues = { port?: string; host?: string; token?: string; json?: boolean; help?: boolean }

/**
 * `parseArgs`, with a bad argument turned into a UsageError instead of Node's
 * own message-and-exit-1.
 *
 * A thin wrapper around the call rather than a generic reimplementation of it,
 * so TypeScript infers each command's own value types — string flag, boolean
 * flag, `multiple` array — straight from the literal options object it wrote,
 * instead of collapsing every command to the same loose union.
 */
function parse<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
}

/** Print a result, either as one line of JSON or the caller's formatted text. */
function show(json: boolean | undefined, result: unknown, formatted: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${formatted()}\n`)
}

/** stop.kind === 'breakpoint' | 'watchpoint' is HIT; everything else that succeeded is OK. */
function exitForStop(stop: { kind: string } | undefined): number {
  if (stop?.kind === 'breakpoint' || stop?.kind === 'watchpoint') return ExitCode.HIT
  return ExitCode.OK
}

const call = (values: CommonValues, method: string, params?: unknown): Promise<unknown> =>
  httpCall(resolveTarget(values), method, params)

/** Connection flags that take a following value, for extractSubcommand below. */
const FLAG_WITH_VALUE = new Set(['--port', '--host', '--token'])

/**
 * Pull the sub-subcommand — `write` out of `mem write $0300 ...` — out of an
 * argv that may have connection flags ahead of it.
 *
 * `attach` resolves `--port`/`--host`/`--token` once and hands them to every
 * typed line, and where exactly it puts them relative to the line's own
 * tokens is an implementation detail of attach.ts that a two-level command
 * here should not have to stay in sync with. Scanning past known flags (and
 * their values) rather than assuming the sub-subcommand is always argv[0]
 * means it doesn't matter.
 */
function extractSubcommand(argv: string[]): { sub: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (FLAG_WITH_VALUE.has(token)) {
      i++
      continue
    }
    if (token.startsWith('-')) continue
    return { sub: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] }
  }
  return { sub: undefined, rest: argv }
}

//
// session
//

async function info(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'session.info')) as {
    host: string
    version: string
    console: string
    frequency: number
    serialCard: boolean
    flowControl?: boolean
    mode: string
    cycles: number
  }
  // Flow control only when it is off, which is not the default. A host too old
  // to report it says nothing.
  const flow = result.flowControl === false ? ', no flow control' : ''
  show(values.json, result, () =>
    `${result.host} ${result.version} — ${result.console} console, ` +
    `${(result.frequency / 1e6).toFixed(0)} MHz, ` +
    `${result.serialCard ? 'Serial Card fitted' : 'no Serial Card'}${flow}, ` +
    `${result.mode}, ${result.cycles} cycles`
  )
  return ExitCode.OK
}

async function reset(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, warm: { type: 'boolean' } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  const result = await call(values, 'session.reset', { cold: !values.warm })
  show(values.json, result, () => 'reset')
  return ExitCode.OK
}

/**
 * `--frequency` is accepted and passed through, though nothing can come of it.
 *
 * PHI2 on this board is fixed, and the method table refuses a value that is not
 * the one the machine has rather than ignoring it — so a script ported from
 * 6502-EMULATOR's tooling is *told* the clock did not change instead of
 * believing it did. Dropping the flag here would turn that into "unknown
 * option", which says nothing about why.
 */
async function config(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    frequency: { type: 'string' },
    baud: { type: 'string' },
    'flow-control': { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const params: Record<string, number | boolean> = {}
  if (values.frequency) {
    const mhz = Number(values.frequency)
    params.frequency = mhz === 1 || mhz === 2 ? mhz * 1_000_000 : Number(values.frequency)
  }
  if (values.baud) params.baudRate = parseCount(values.baud, '--baud')
  if (values['flow-control'] !== undefined) {
    const setting = values['flow-control'].trim().toLowerCase()
    if (setting !== 'on' && setting !== 'off') {
      throw new UsageError(`--flow-control: expected "on" or "off", got "${values['flow-control']}"`)
    }
    params.flowControl = setting === 'on'
  }

  const result = await call(values, 'session.config', params)
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function shutdown(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  await call(values, 'session.shutdown')
  show(values.json, { ok: true }, () => 'shutting down')
  return ExitCode.OK
}

//
// reg
//

async function regs(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, set: { type: 'string', multiple: true } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const sets = values.set ?? []
  let result: unknown

  if (sets.length > 0) {
    const params: Record<string, string> = {}
    for (const assignment of sets) {
      const split = assignment.indexOf('=')
      if (split === -1) throw new UsageError(`--set: expected NAME=VALUE, got "${assignment}"`)
      const name = assignment.slice(0, split).toUpperCase()
      const raw = assignment.slice(split + 1)
      params[name] = /^\$|^0x/i.test(raw) ? String(parseInt(raw.replace(/^\$|^0x/i, ''), 16)) : raw
    }
    // reg.set wants numbers; the params above stayed strings only so a $-hex
    // value could be told apart from a decimal one before conversion.
    const numeric: Record<string, number> = {}
    for (const [name, value] of Object.entries(params)) numeric[name] = Number(value)
    result = await call(values, 'reg.set', numeric)
  } else {
    result = await call(values, 'reg.get')
  }

  show(values.json, result, () => formatRegisters(result as Parameters<typeof formatRegisters>[0]))
  return ExitCode.OK
}

//
// mem
//

async function mem(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)

  if (sub === 'write') return memWrite(rest)
  if (sub === 'fill') return memFill(rest)
  if (sub === 'search') return memSearch(rest)
  return memRead(argv)
}

const SPACE_OPTION = { space: { type: 'string' } } as const

/**
 * The address to send for a `mem` call, given the space it is in.
 *
 * In `cpu` space this stays a string: the server resolves `$E000`, `0xE000`,
 * plain decimal *and* symbol names, and a client that parsed it first would be
 * the one deciding `KcMain` is not an address. Every other space takes an
 * offset into an image, which the protocol wants as a number — so the hex a
 * 6502 programmer writes is converted here rather than coming back as
 * "expected a number, got \\"0x1FFC\\"".
 */
function memAddress(space: string | undefined, text: string): string | number {
  if (space === undefined || space === 'cpu') return text
  return parseAddress(text, 'address')
}

async function memRead(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('mem: expected an address')

  const address = positionals[0]!
  const length = positionals[1] ? parseCount(positionals[1], 'length') : 16

  const result = (await call(values, 'mem.read', {
    ...(values.space ? { space: values.space } : {}),
    address: memAddress(values.space, address),
    length
  })) as { address: number; data: string }

  const bytes = Buffer.from(result.data, 'base64')
  show(values.json, result, () => hexDump(result.address, bytes))
  return ExitCode.OK
}

async function memWrite(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 2) throw new UsageError('mem write: expected an address and bytes')

  const data = parseByteList(positionals.slice(1).join(' '), 'mem write')
  const result = await call(values, 'mem.write', {
    ...(values.space ? { space: values.space } : {}),
    address: memAddress(values.space, positionals[0]!),
    data
  })
  show(values.json, result, () => `wrote ${data.length} byte(s)`)
  return ExitCode.OK
}

async function memFill(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, ...SPACE_OPTION } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 3) {
    throw new UsageError('mem fill: expected an address, a length and a value')
  }

  const result = await call(values, 'mem.fill', {
    ...(values.space ? { space: values.space } : {}),
    address: memAddress(values.space, positionals[0]!),
    length: parseCount(positionals[1]!, 'length'),
    value: parseByte(positionals[2]!, 'value')
  })
  show(values.json, result, () => `filled ${positionals[1]} byte(s)`)
  return ExitCode.OK
}

async function memSearch(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    ...SPACE_OPTION,
    text: { type: 'boolean' },
    start: { type: 'string' },
    end: { type: 'string' },
    limit: { type: 'string' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('mem search: expected a pattern')

  const pattern = values.text ? positionals.join(' ') : parseByteList(positionals.join(' '), 'pattern')

  const result = (await call(values, 'mem.search', {
    ...(values.space ? { space: values.space } : {}),
    pattern,
    ...(values.start !== undefined ? { start: parseCount(values.start, '--start') } : {}),
    ...(values.end !== undefined ? { end: parseCount(values.end, '--end') } : {}),
    ...(values.limit !== undefined ? { limit: parseCount(values.limit, '--limit') } : {})
  })) as { matches: number[]; truncated: boolean }

  show(values.json, result, () =>
    result.matches.length === 0
      ? '(no matches)'
      : result.matches.map((address) => `$${address.toString(16).toUpperCase()}`).join('\n') +
        (result.truncated ? '\n... (truncated)' : '')
  )
  return ExitCode.OK
}

//
// disasm
//

async function disasm(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'range') return disasmRange(rest)
  return disasmAt(argv)
}

async function disasmAt(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'disasm.at', {
    ...(positionals[0] !== undefined ? { address: positionals[0] } : {}),
    count: positionals[1] ? parseCount(positionals[1], 'count') : 8
  })) as { instructions: { address: number }[] }

  show(values.json, result, () => formatDisasm(result.instructions as never))
  return ExitCode.OK
}

async function disasmRange(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 2) throw new UsageError('disasm range: expected a start and an end')

  const result = await call(values, 'disasm.range', { start: positionals[0], end: positionals[1] })
  show(values.json, result, () =>
    formatDisasm((result as { instructions: unknown[] }).instructions as never)
  )
  return ExitCode.OK
}

//
// bp
//

async function breakCmd(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'list') return breakList(rest)
  if (sub === 'clear') return breakClear(rest)
  if (sub === 'enable') return breakSetEnabled(rest, true)
  if (sub === 'disable') return breakSetEnabled(rest, false)
  return breakSet(argv)
}

async function breakSet(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    watch: { type: 'string' },
    end: { type: 'string' },
    condition: { type: 'string' },
    ignore: { type: 'string' },
    temporary: { type: 'boolean' },
    disabled: { type: 'boolean' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('break: expected an address')

  const result = await call(values, 'bp.set', {
    address: positionals[0],
    kind: values.watch ?? 'exec',
    ...(values.end !== undefined ? { end: values.end } : {}),
    ...(values.condition !== undefined ? { condition: values.condition } : {}),
    ...(values.ignore !== undefined ? { ignoreCount: parseCount(values.ignore, '--ignore') } : {}),
    ...(values.temporary ? { temporary: true } : {}),
    ...(values.disabled ? { enabled: false } : {})
  })
  show(values.json, result, () => formatBreakpoint(result as never))
  return ExitCode.OK
}

async function breakList(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'bp.list')) as { breakpoints: unknown[] }
  show(values.json, result, () => formatBreakpoints(result.breakpoints as never))
  return ExitCode.OK
}

async function breakClear(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = await call(
    values,
    'bp.clear',
    positionals[0] !== undefined ? { id: parseCount(positionals[0], 'id') } : {}
  )
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function breakSetEnabled(argv: string[], enabled: boolean): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('break: expected a breakpoint id')

  const result = await call(values, enabled ? 'bp.enable' : 'bp.disable', {
    id: parseCount(positionals[0]!, 'id')
  })
  show(values.json, result, () => formatBreakpoint(result as never))
  return ExitCode.OK
}

//
// exec
//

async function run(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, realtime: { type: 'boolean' } } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  const result = await call(values, 'exec.run', { mode: values.realtime ? 'realtime' : 'turbo' })
  show(values.json, result, () => 'running')
  return ExitCode.OK
}

async function pause(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'exec.pause')) as { stop: { kind: string } }
  show(values.json, result, () => formatStop(result.stop as never))
  return ExitCode.OK
}

async function step(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    over: { type: 'boolean' },
    out: { type: 'boolean' },
    cycle: { type: 'boolean' },
    count: { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const kind = values.over ? 'over' : values.out ? 'out' : values.cycle ? 'cycle' : 'instruction'
  const result = (await call(values, 'exec.step', {
    kind,
    ...(values.count !== undefined ? { count: parseCount(values.count, '--count') } : {})
  })) as { stop: { kind: string }; registers: unknown }

  show(values.json, result, () => `${formatStop(result.stop as never)}\n${formatRegisters(result.registers as never)}`)
  return exitForStop(result.stop)
}

async function runTo(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, timeout: { type: 'string' }, realtime: { type: 'boolean' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('runto: expected an address')

  const result = (await call(values, 'exec.runTo', {
    address: positionals[0],
    mode: values.realtime ? 'realtime' : 'turbo',
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { stop: { kind: string }; registers: unknown }

  show(values.json, result, () => `${formatStop(result.stop as never)}\n${formatRegisters(result.registers as never)}`)
  return exitForStop(result.stop)
}

async function runCycles(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('runcycles: expected a cycle count')

  const result = (await call(values, 'exec.runCycles', {
    cycles: parseCount(positionals[0]!, 'cycles')
  })) as { stop: { kind: string } }
  show(values.json, result, () => formatStop(result.stop as never))
  return exitForStop(result.stop)
}

//
// serial
//

async function send(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    wait: { type: 'string' },
    since: { type: 'string' },
    timeout: { type: 'string' },
    encoding: { type: 'string' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('send: expected text to send')

  const data = values.encoding === 'base64' ? positionals[0]! : unescape(positionals.join(' '))
  const written = (await call(values, 'serial.write', {
    data,
    ...(values.encoding ? { encoding: values.encoding } : {})
  })) as { queued: number; cursor?: number }

  if (!values.wait) {
    show(values.json, written, () => `sent ${written.queued} byte(s)`)
    return ExitCode.OK
  }

  // The wait looks back to where this write landed, so a reply that arrives
  // before it is set up still counts. `--since` overrides that with a cursor the
  // caller already holds — the one the previous `--json` result ended on — so a
  // sequence of commands reads the console with no gap between them.
  const since =
    values.since !== undefined ? parseCursor(values.since, '--since') : written.cursor

  const waited = (await call(values, 'wait.for', {
    serial: values.wait,
    ...(since !== undefined ? { since } : {}),
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { matched: boolean; reason: string; output?: string; cursor?: number }

  show(values.json, waited, () => waited.output ?? waited.reason)
  return waited.matched ? ExitCode.OK : ExitCode.TIMEOUT
}

async function wait(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    serial: { type: 'string' },
    stopped: { type: 'boolean' },
    cycles: { type: 'string' },
    expression: { type: 'string' },
    since: { type: 'string' },
    timeout: { type: 'string' },
    run: { type: 'string' }
  } as const
  const { values } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const result = (await call(values, 'wait.for', {
    ...(values.serial !== undefined ? { serial: values.serial } : {}),
    ...(values.stopped ? { stopped: true } : {}),
    ...(values.cycles !== undefined ? { cycles: parseCount(values.cycles, '--cycles') } : {}),
    ...(values.expression !== undefined ? { expression: values.expression } : {}),
    ...(values.since !== undefined ? { since: parseCursor(values.since, '--since') } : {}),
    ...(values.run !== undefined ? { run: values.run } : {}),
    ...(values.timeout ? { timeoutMs: parseDuration(values.timeout, '--timeout') } : {})
  })) as { matched: boolean; reason: string; output?: string; stop?: { kind: string } }

  show(values.json, result, () => result.output ?? (result.stop ? formatStop(result.stop as never) : result.reason))
  return result.matched ? ExitCode.OK : ExitCode.TIMEOUT
}

//
// sym
//

async function sym(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'resolve') return symResolve(rest)
  if (sub === 'lookup') return symLookup(rest)
  if (sub === 'list') return symList(rest)
  if (sub === 'load') return symLoad(rest)
  throw new UsageError(`sym: expected load, resolve, lookup or list, got "${sub ?? ''}"`)
}

async function symLoad(argv: string[]): Promise<number> {
  const OPTIONS = {
    ...COMMON_OPTIONS,
    format: { type: 'string' },
    'no-merge': { type: 'boolean' }
  } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym load: expected a file path')

  const result = await call(values, 'sym.load', {
    path: resolvePath(process.cwd(), positionals[0]!),
    ...(values.format ? { format: values.format } : {}),
    ...(values['no-merge'] ? { merge: false } : {})
  })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symResolve(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym resolve: expected a name')

  const result = await call(values, 'sym.resolve', { name: positionals[0] })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symLookup(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  if (positionals.length < 1) throw new UsageError('sym lookup: expected an address')

  const result = await call(values, 'sym.lookup', { address: positionals[0] })
  show(values.json, result, () => JSON.stringify(result))
  return ExitCode.OK
}

async function symList(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, limit: { type: 'string' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  const result = (await call(values, 'sym.list', {
    ...(positionals[0] !== undefined ? { prefix: positionals[0] } : {}),
    ...(values.limit !== undefined ? { limit: parseCount(values.limit, '--limit') } : {})
  })) as { symbols: unknown[] }
  show(values.json, result, () => formatSymbols(result.symbols as never))
  return ExitCode.OK
}

//
// media
//

/**
 * `load rom|card-rom|bin`.
 *
 * `card-rom` is where 6502-EMULATOR has `cart`, and the rename is the point:
 * this replaces the machine's own firmware — the scripted equivalent of
 * Settings → FILES → Keypad Card ROM, for testing a `KC Monitor.bin` built in
 * the sibling repository — rather than slotting a cartridge into a socket the
 * board does not have. There is nothing to unload it into, so there is no
 * `unload`.
 */
async function load(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)

  if (sub === 'rom' || sub === 'card-rom') {
    const { values, positionals } = parse(() => parseArgs({ args: rest, options: COMMON_OPTIONS, allowPositionals: true }))
    if (positionals.length < 1) throw new UsageError(`load ${sub}: expected a file path`)

    const method = sub === 'rom' ? 'media.loadROM' : 'media.loadCardROM'
    const result = await call(values, method, { path: resolvePath(process.cwd(), positionals[0]!) })
    show(values.json, result, () => JSON.stringify(result))
    return ExitCode.OK
  }

  if (sub === 'bin') {
    const { values, positionals } = parse(() => parseArgs({ args: rest, options: COMMON_OPTIONS, allowPositionals: true }))
    if (positionals.length < 2) throw new UsageError('load bin: expected an address and a file path')

    const result = await call(values, 'media.loadBinary', {
      address: positionals[0],
      path: resolvePath(process.cwd(), positionals[1]!)
    })
    show(values.json, result, () => JSON.stringify(result))
    return ExitCode.OK
  }

  throw new UsageError(`load: expected rom, card-rom or bin, got "${sub ?? ''}"`)
}

//
// keypad
//

/**
 * Press keys on the pad — the whole of this machine's input.
 *
 * Where 6502-EMULATOR has `input key`, `input joystick` and `input type`. There
 * is no `--down`/`--up` here and no release: the 74C922 latches the press and
 * reports nothing else, so a release is a signal the hardware never sends.
 *
 * Several keys in one call rather than several calls, because the pacing that
 * makes a sequence survive is measured in emulated cycles — the latch holds one
 * code and the monitor's interrupt handler clearing it is what makes room for
 * the next. Two separate one-shot processes cannot pace anything.
 */
async function key(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, kps: { type: 'string' }, list: { type: 'boolean' } } as const
  const { values, positionals } = parse(() => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }))

  if (values.list) {
    const map = (await call(values, 'keypad.map')) as { keys: unknown[] }
    show(values.json, map, () => formatKeypad(map.keys as never))
    return ExitCode.OK
  }

  if (positionals.length < 1) {
    throw new UsageError('key: expected a key name or code — "key --list" shows the pad')
  }

  // A name (`INS`, `PGUP`, `A`, `LEFT`), or the encoder's own code written as
  // `$14` or `0x14`. A bare number stays a *name*, deliberately: the code is not
  // the key's value — `0` is $0A and `C`-`F` run backwards — so reading `key 0`
  // as a code would press ◄ when every finger in the world meant the zero key.
  const keys = positionals.map((raw) => {
    const hex = raw.startsWith('$') ? raw.slice(1) : /^0x/i.test(raw) ? raw.slice(2) : null
    return hex === null ? raw : parseInt(hex, 16)
  })

  const result = (await call(values, 'keypad.press', {
    keys,
    ...(values.kps !== undefined ? { kps: parseCount(values.kps, '--kps') } : {})
  })) as { keys: { label: string }[] }

  show(values.json, result, () => `pressed ${result.keys.map((k) => k.label).join(' ')}`)
  return ExitCode.OK
}

//
// lcd
//

/**
 * Read the 16x2 on the Keypad LCD Helper.
 *
 * Where 6502-EMULATOR has `screen`. Not a secondary display: on a KIM this is
 * the machine's own panel, the one the KC Monitor draws its address and byte on,
 * and on a machine with no Serial Card it is the only thing to read. There is no
 * `lcd png` — two lines of sixteen characters is small enough to read as text,
 * and `lcd pixels` prints the dot matrix for anything finer.
 */
async function lcd(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'hash') return lcdHash(rest)
  if (sub === 'pixels') return lcdPixels(rest)
  return lcdText(rest) // default, and explicit "text"
}

async function lcdText(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'lcd.text')) as { lines: string[] }
  show(values.json, result, () => formatLCD(result.lines))
  return ExitCode.OK
}

async function lcdHash(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'lcd.hash')) as { hash: string }
  show(values.json, result, () => result.hash)
  return ExitCode.OK
}

async function lcdPixels(argv: string[]): Promise<number> {
  const { values } = parse(() => parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true }))
  const result = (await call(values, 'lcd.pixels')) as {
    width: number
    height: number
    data: string
  }
  show(values.json, result, () =>
    formatLCDPixels({
      width: result.width,
      height: result.height,
      data: new Uint8Array(Buffer.from(result.data, 'base64'))
    })
  )
  return ExitCode.OK
}

//
// state
//

/** Where a snapshot goes when the caller does not say. */
const DEFAULT_STATE_FILE = 'machine.state'

async function state(argv: string[]): Promise<number> {
  const { sub, rest } = extractSubcommand(argv)
  if (sub === 'save') return stateSave(rest)
  if (sub === 'load') return stateLoad(rest)
  throw new UsageError(`state: expected save or load, got "${sub ?? ''}"`)
}

/**
 * Write the machine's state to a file here, rather than asking the emulator to.
 *
 * The emulator may be a packaged desktop app in another directory, or on another
 * machine over `--host`; the cwd that matters is this process's. So the snapshot
 * comes back over the wire and gets written locally.
 */
async function stateSave(argv: string[]): Promise<number> {
  const { values, positionals } = parse(() =>
    parseArgs({ args: argv, options: COMMON_OPTIONS, allowPositionals: true })
  )
  const result = (await call(values, 'state.save')) as { state: unknown; bytes: number }

  if (values.json) {
    show(true, result, () => '')
    return ExitCode.OK
  }

  const outPath = resolvePath(process.cwd(), positionals[0] ?? DEFAULT_STATE_FILE)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, `${JSON.stringify(result.state)}\n`)
  process.stdout.write(`wrote ${result.bytes} bytes to ${outPath}\n`)
  return ExitCode.OK
}

async function stateLoad(argv: string[]): Promise<number> {
  const OPTIONS = { ...COMMON_OPTIONS, force: { type: 'boolean' } } as const
  const { values, positionals } = parse(() =>
    parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  )

  const inPath = resolvePath(process.cwd(), positionals[0] ?? DEFAULT_STATE_FILE)
  const { readFileSync } = await import('node:fs')

  let snapshot: unknown
  try {
    snapshot = JSON.parse(readFileSync(inPath, 'utf8'))
  } catch (e) {
    throw new UsageError(`state load: cannot read "${inPath}": ${(e as Error).message}`)
  }

  // Sent inline rather than as a path, to match save: the file is here, and the
  // emulator may not be able to see it at all.
  const result = (await call(values, 'state.load', {
    state: snapshot,
    ...(values.force ? { force: true } : {})
  })) as { romMismatch?: unknown; cycles: number }

  show(values.json, result, () =>
    result.romMismatch
      ? `restored ${inPath} (warning: the ROMs do not match the snapshot)`
      : `restored ${inPath}`
  )
  return ExitCode.OK
}

//
// dispatch
//

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  info,
  regs,
  reset,
  config,
  shutdown,
  reg: regs,
  mem,
  disasm,
  break: breakCmd,
  run,
  pause,
  step,
  runto: runTo,
  runcycles: runCycles,
  send,
  wait,
  sym,
  load,
  key,
  lcd,
  state
}

export async function dispatch(name: string | undefined, argv: string[]): Promise<number> {
  const handler = name ? COMMANDS[name] : undefined
  if (!handler) {
    process.stderr.write(
      `6502-kim dbg: unknown command "${name ?? ''}"\n\n` +
        `Commands: ${Object.keys(COMMANDS).filter((k) => k !== 'reg').sort().join(', ')}\n`
    )
    return ExitCode.ERROR
  }

  try {
    return await handler(argv)
  } catch (e) {
    if (e instanceof RpcClientError) {
      process.stderr.write(`6502-kim dbg: ${e.message}\n`)
      return e.exitCode
    }
    if (e instanceof UsageError) {
      process.stderr.write(`6502-kim dbg: ${e.message}\n`)
      return ExitCode.ERROR
    }
    throw e
  }
}

export const COMMAND_NAMES = Object.keys(COMMANDS).filter((name) => name !== 'reg').sort()
