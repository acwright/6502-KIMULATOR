import { CPU } from '../../core/CPU'
import { RAM } from '../../core/RAM'
import { ROM } from '../../core/ROM'
import { CardROM } from '../../core/CardROM'
import type { Machine } from '../../core/Machine'
import { KEYPAD, keyForCode, keyForName, keyNames } from '../../core/KeypadMap'
import type { KeypadKey } from '../../core/KeypadMap'
import { loadBinary } from '../../core/ProgramImage'
import { disassemble, disassembleRange, formatInstruction } from '../Disassembler'
import type { Instruction } from '../Disassembler'
import { compileExpression, ExpressionError } from '../Expression'
import type { StepKind, StopReason } from '../Session'
import type { Breakpoint } from '../Breakpoints'
import { parseSymbols, formatForPath } from '../symbols/parse'
import type { SymbolFormat } from '../symbols/parse'
import { crc32 } from '../Checksums'
import {
  captureSnapshot,
  restoreSnapshot,
  StateError,
  SNAPSHOT_VERSION
} from '../Snapshot'
import type { DebugTarget } from './DebugTarget'
import {
  ErrorCode,
  PROTOCOL_VERSION,
  RpcMethodError,
  invalidParams,
  notSupported
} from './Protocol'
import {
  asObject,
  base64,
  oneOf,
  optionalAddress,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireAddress,
  requireNumber,
  requireString,
  toBytes,
  toRegExp
} from './Params'
import type { Params } from './Params'

export type MethodHandler = (params: unknown) => unknown | Promise<unknown>
export type MethodTable = Record<string, MethodHandler>

/** How long `wait.for` waits when the caller does not say. */
const DEFAULT_WAIT_MS = 10_000

/** Ceiling on a single `mem.read`, so one call cannot hand back a 256 MB reply. */
const MAX_READ_LENGTH = 1 << 20

//
// Memory spaces
//

const SPACES = ['cpu', 'ram', 'rom', 'card'] as const
export type MemorySpace = (typeof SPACES)[number]

interface SpaceAccess {
  size: number
  read(offset: number): number
  write(offset: number, value: number): void
}

/**
 * Resolve a named memory space to something byte-addressable.
 *
 * `cpu` is the 64K the processor sees, through the address decode, so it obeys
 * the Keypad Card's overlay and reads the PIA's registers as the program would.
 * The other three reach an image directly. That is the only way to see the whole
 * of `BIOS.bin` on this machine at all: above $A000 the card overlays it, so
 * $C000–$FFFF of the image is unreachable through the CPU space and readable
 * only here.
 */
function spaceAccess(machine: Machine, space: MemorySpace): SpaceAccess {
  switch (space) {
    case 'cpu':
      return {
        size: 0x10000,
        read: (offset) => machine.peek(offset),
        write: (offset, value) => machine.poke(offset, value)
      }

    case 'ram':
      return {
        size: RAM.SIZE,
        read: (offset) => machine.ram.data[offset] ?? 0,
        write: (offset, value) => {
          machine.ram.data[offset] = value
        }
      }

    case 'rom':
      return {
        size: ROM.SIZE,
        read: (offset) => machine.rom.data[offset] ?? 0,
        // Patching the ROM image is a legitimate debugging move — it is what
        // "try this fix without rebuilding" looks like. Writing through the CPU
        // space cannot do it, because the hardware ignores writes there.
        write: (offset, value) => {
          machine.rom.data[offset] = value
        }
      }

    // The Keypad Card's 8 KB, offset from $E000. Patchable for the same reason
    // the BIOS is, and more often: the KC Monitor is the firmware under
    // development here, and poking a byte of it is how you try a fix without
    // rebuilding and reloading the image.
    case 'card':
      return {
        size: CardROM.SIZE,
        read: (offset) => machine.cardROM.data[offset] ?? 0,
        write: (offset, value) => {
          machine.cardROM.data[offset] = value
        }
      }
  }
}

/**
 * The offset a space request starts at.
 *
 * For `cpu` the parameter is an address in the processor's map. For every other
 * space it is an offset from the start of that image, which is why `ram` and
 * `cpu` agree below $8000, `rom` is offset from $8000 rather than addressed at
 * it, and `card` is offset from $E000.
 */
function spaceOffset(params: Params, space: MemorySpace, resolve?: (n: string) => number | undefined): number {
  if (space === 'cpu') return requireAddress(params, 'address', resolve)

  const value = optionalNumber(params, 'address')
  if (value === undefined) throw invalidParams('address is required')
  if (!Number.isInteger(value) || value < 0) {
    throw invalidParams(`address: expected a non-negative offset into ${space}, got ${value}`)
  }
  return value
}

//
// Serialisation
//

function flagsOf(status: number): Record<string, boolean> {
  return {
    N: (status & CPU.N) !== 0,
    V: (status & CPU.V) !== 0,
    B: (status & CPU.B) !== 0,
    D: (status & CPU.D) !== 0,
    I: (status & CPU.I) !== 0,
    Z: (status & CPU.Z) !== 0,
    C: (status & CPU.C) !== 0
  }
}

function registersOf(cpu: CPU): Record<string, unknown> {
  return {
    A: cpu.a,
    X: cpu.x,
    Y: cpu.y,
    PC: cpu.pc,
    SP: cpu.sp,
    P: cpu.st,
    flags: flagsOf(cpu.st)
  }
}

function instructionJSON(instruction: Instruction): Record<string, unknown> {
  return {
    address: instruction.address,
    bytes: [...instruction.bytes],
    name: instruction.name,
    mode: instruction.mode,
    operand: instruction.operand,
    ...(instruction.target === undefined ? {} : { target: instruction.target }),
    ...(instruction.label === undefined ? {} : { label: instruction.label }),
    documented: instruction.documented,
    /** Pre-rendered listing line, so a client need not reimplement formatting. */
    text: formatInstruction(instruction).trim()
  }
}

function breakpointJSON(breakpoint: Breakpoint): Record<string, unknown> {
  return {
    id: breakpoint.id,
    kind: breakpoint.kind,
    address: breakpoint.address,
    end: breakpoint.end,
    ...(breakpoint.condition === undefined ? {} : { condition: breakpoint.condition }),
    ignoreCount: breakpoint.ignoreCount,
    temporary: breakpoint.temporary,
    enabled: breakpoint.enabled,
    hits: breakpoint.hits
  }
}

/**
 * Build the method table for a target.
 *
 * A plain object of named functions rather than a switch, so the same table can
 * be dispatched from the socket server here and from an IPC handler in Phase 7
 * without either one enumerating the methods.
 */
export function createMethods(target: DebugTarget): MethodTable {
  const { session } = target
  const machine = session.machine
  const resolveSymbol = (name: string): number | undefined => target.symbols.resolve(name)

  const state = (): Record<string, unknown> => ({
    mode: session.mode,
    running: session.isRunning,
    cycles: session.cycles,
    registers: registersOf(machine.cpu)
  })

  const stopped = (reason: StopReason): Record<string, unknown> => ({
    stop: reason,
    ...state()
  })

  const space = (params: Params): MemorySpace => oneOf(params, 'space', SPACES) ?? 'cpu'

  /**
   * Where the console stream stood when the last `serial.write` went out.
   *
   * The default `since` for `wait.for`, which is what makes the common flow —
   * send a command, wait for its reply — correct without the caller tracking
   * anything. Waiting "from now" cannot work for one-shot callers: in turbo the
   * machine covers hundreds of thousands of cycles between two RPC calls, so
   * the reply is usually already printed by the time the wait is set up.
   */
  let lastWriteCursor: number | undefined

  /**
   * The panel's two lines as text.
   *
   * Read out of DDRAM through the controller's own scroll and row mapping, so
   * what comes back is what a person looking at the glass would read — a shifted
   * display reports what is showing, not what is stored. Characters the A00 font
   * has but ASCII does not arrive as their code point, which is the honest thing
   * to do with a display whose character set is not Unicode.
   */
  const lcdLines = (): string[] => {
    const lcd = machine.lcd
    return Array.from({ length: lcd.rows }, (_, row) => lcd.getRowText(row))
  }

  /**
   * Bytes for a media method, from an inline `data` field or a host file.
   *
   * Always async: the headless host reads synchronously and a sync value
   * awaits to itself, but the Electron renderer has no filesystem access of
   * its own and proxies the read to the main process over IPC.
   */
  const mediaBytes = async (params: Params, method: string): Promise<Uint8Array> => {
    const path = optionalString(params, 'path')
    if (path !== undefined) {
      if (!target.readBinaryFile) {
        throw notSupported(`${method}: this host cannot read files — pass "data" instead`)
      }
      try {
        return await target.readBinaryFile(path)
      } catch (e) {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `${method}: cannot read "${path}": ${(e as Error).message}`
        )
      }
    }
    if (params.data === undefined) throw invalidParams(`${method}: need "path" or "data"`)
    return toBytes(params.data, 'data')
  }

  return {
    //
    // session
    //

    'session.info': () => ({
      protocol: PROTOCOL_VERSION,
      host: target.hostName,
      version: target.version,
      console: target.consoleMode(),
      frequency: machine.frequency,
      ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
      // RTS/CTS flow control on serial input: on unless `--no-flow-control`,
      // `session.config` or the app's Settings turned it off.
      flowControl: machine.flowControl,
      /**
       * Whether io5 holds the Serial Card.
       *
       * Where 6502-EMULATOR reports `cartridge`. There is no cartridge to report
       * on a KIM — the Keypad Card is soldered in and always present — but
       * whether the Serial Card is fitted is a real question about this machine,
       * and the answer changes which methods work.
       */
      serialCard: machine.acia() !== undefined,
      symbols: target.symbols.size,
      ...state()
    }),

    'session.reset': (raw) => {
      const params = asObject(raw, 'session.reset')
      session.reset(optionalBoolean(params, 'cold') ?? true)
      return state()
    },

    /**
     * `frequency` is reported here and cannot be set. PHI2 on this board is
     * 1 MHz; the 2 MHz jumper is the ACE's. Asking for a different one is
     * refused rather than ignored — a client ported from 6502-EMULATOR's
     * tooling would otherwise believe it had changed the clock.
     */
    'session.config': (raw) => {
      const params = asObject(raw, 'session.config')

      if (params.frequency !== undefined && params.frequency !== machine.frequency) {
        throw invalidParams(
          `frequency: PHI2 on this machine is fixed at ${machine.frequency} — only the ACE has the 2 MHz jumper`
        )
      }

      const baudRate = optionalNumber(params, 'baudRate')
      if (baudRate !== undefined) {
        if (!target.setBaudRate) throw notSupported('session.config: no serial console')
        if (!Number.isInteger(baudRate) || baudRate <= 0) {
          throw invalidParams(`baudRate: expected a positive integer, got ${baudRate}`)
        }
        target.setBaudRate(baudRate)
      }

      const flowControl = optionalBoolean(params, 'flowControl')
      if (flowControl !== undefined) {
        if (!target.setFlowControl) {
          throw notSupported('session.config: flowControl is set in the app\'s Settings on this host')
        }
        target.setFlowControl(flowControl)
      }

      return {
        frequency: machine.frequency,
        ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
        flowControl: machine.flowControl,
        console: target.consoleMode()
      }
    },

    'session.shutdown': () => {
      if (!target.shutdown) throw notSupported('session.shutdown: this host cannot be shut down')
      // Answer before winding down, or the caller sees a dropped socket instead
      // of a result. The host stops once this turn of the loop unwinds.
      setTimeout(() => target.shutdown?.(), 0)
      return { ok: true }
    },

    //
    // exec
    //

    'exec.state': () => state(),

    'exec.run': (raw) => {
      const params = asObject(raw, 'exec.run')
      session.run(oneOf(params, 'mode', ['realtime', 'turbo'] as const) ?? 'turbo')
      return state()
    },

    'exec.pause': () => stopped(session.pause()),

    'exec.step': (raw) => {
      const params = asObject(raw, 'exec.step')
      const kind = (oneOf(params, 'kind', ['instruction', 'cycle', 'over', 'out'] as const) ??
        'instruction') as StepKind
      const count = optionalNumber(params, 'count') ?? 1
      if (!Number.isInteger(count) || count < 1) {
        throw invalidParams(`count: expected a positive integer, got ${count}`)
      }
      return stopped(session.step(kind, count))
    },

    'exec.runCycles': (raw) => {
      const params = asObject(raw, 'exec.runCycles')
      const cycles = requireNumber(params, 'cycles')
      if (!Number.isInteger(cycles) || cycles < 1) {
        throw invalidParams(`cycles: expected a positive integer, got ${cycles}`)
      }
      return stopped(session.runCycles(cycles))
    },

    'exec.runTo': async (raw) => {
      const params = asObject(raw, 'exec.runTo')
      const address = requireAddress(params, 'address', resolveSymbol)
      const timeoutMs = optionalNumber(params, 'timeoutMs') ?? DEFAULT_WAIT_MS
      const mode =
        oneOf(params, 'mode', ['realtime', 'turbo'] as const) ??
        (session.mode === 'realtime' ? 'realtime' : 'turbo')

      // A breakpoint stops *before* the instruction at its address, so starting
      // on top of the target would return having run nothing — which makes
      // run-to-cursor useless inside a loop. Clear the current instruction
      // first, then the wait is for the next time round.
      if (machine.cpu.pc === address) session.step('instruction')

      const breakpoint = session.addBreakpoint({ address, temporary: true })

      const reason = await new Promise<StopReason>((resolve) => {
        let settled = false
        const finish = (value: StopReason): void => {
          if (settled) return
          settled = true
          off()
          clearTimeout(timer)
          resolve(value)
        }

        const off = session.onStop(finish)
        const timer = setTimeout(() => {
          session.removeBreakpoint(breakpoint.id)
          finish(session.pause())
        }, timeoutMs)

        session.run(mode)
      })

      // A temporary breakpoint removes itself when it fires; this covers every
      // other way out, including stopping at a different breakpoint entirely.
      session.removeBreakpoint(breakpoint.id)
      return stopped(reason)
    },

    //
    // bp
    //

    'bp.set': (raw) => {
      const params = asObject(raw, 'bp.set')
      const condition = optionalString(params, 'condition')

      try {
        return breakpointJSON(
          session.addBreakpoint({
            kind: oneOf(params, 'kind', ['exec', 'read', 'write', 'access'] as const) ?? 'exec',
            address: requireAddress(params, 'address', resolveSymbol),
            ...(params.end === undefined || params.end === null
              ? {}
              : { end: requireAddress(params, 'end', resolveSymbol) }),
            ...(condition === undefined ? {} : { condition }),
            ...(optionalNumber(params, 'ignoreCount') === undefined
              ? {}
              : { ignoreCount: optionalNumber(params, 'ignoreCount')! }),
            ...(optionalBoolean(params, 'temporary') === undefined
              ? {}
              : { temporary: optionalBoolean(params, 'temporary')! }),
            ...(optionalBoolean(params, 'enabled') === undefined
              ? {}
              : { enabled: optionalBoolean(params, 'enabled')! })
          })
        )
      } catch (e) {
        // A bad condition is the client's mistake, not an internal fault.
        if (e instanceof ExpressionError) throw invalidParams(e.message)
        throw e
      }
    },

    'bp.clear': (raw) => {
      const params = asObject(raw, 'bp.clear')
      const id = optionalNumber(params, 'id')
      if (id === undefined) {
        const cleared = session.breakpoints.list().length
        session.clearBreakpoints()
        return { cleared }
      }
      return { cleared: session.removeBreakpoint(id) ? 1 : 0 }
    },

    'bp.list': () => ({ breakpoints: session.breakpoints.list().map(breakpointJSON) }),

    'bp.enable': (raw) => setEnabled(asObject(raw, 'bp.enable'), true),
    'bp.disable': (raw) => setEnabled(asObject(raw, 'bp.disable'), false),

    //
    // reg
    //

    'reg.get': () => registersOf(machine.cpu),

    'reg.set': (raw) => {
      const params = asObject(raw, 'reg.set')
      const cpu = machine.cpu

      const byte = (name: string): number | undefined => {
        const value = optionalNumber(params, name)
        if (value === undefined) return undefined
        if (!Number.isInteger(value) || value < 0 || value > 0xff) {
          throw invalidParams(`${name}: expected a byte 0-255, got ${value}`)
        }
        return value
      }

      const a = byte('A')
      const x = byte('X')
      const y = byte('Y')
      const sp = byte('SP')
      const p = byte('P')
      const pc = optionalAddress(params, 'PC', resolveSymbol)

      if (a !== undefined) cpu.a = a
      if (x !== undefined) cpu.x = x
      if (y !== undefined) cpu.y = y
      if (sp !== undefined) cpu.sp = sp
      // The unused bit reads as 1 on a real 65C02; keeping it set means a
      // round-trip through reg.get/reg.set does not silently change P.
      if (p !== undefined) cpu.st = p | CPU.U
      if (pc !== undefined) {
        cpu.pc = pc
        // Abandon whatever instruction was mid-flight, or the next tick would
        // finish it against the new PC and execute a spliced-together opcode.
        cpu.cyclesRem = 0
      }

      return registersOf(cpu)
    },

    //
    // mem
    //

    'mem.read': (raw) => {
      const params = asObject(raw, 'mem.read')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      const length = optionalNumber(params, 'length') ?? 1

      if (!Number.isInteger(length) || length < 1 || length > MAX_READ_LENGTH) {
        throw invalidParams(`length: expected 1-${MAX_READ_LENGTH}, got ${length}`)
      }

      const data = new Uint8Array(length)
      for (let i = 0; i < length; i++) {
        data[i] = access.read(wrap(offset + i, access.size, which)) & 0xff
      }

      return { space: which, address: offset, length, data: base64(data) }
    },

    'mem.write': (raw) => {
      const params = asObject(raw, 'mem.write')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      if (params.data === undefined) throw invalidParams('data is required')
      const data = toBytes(params.data, 'data')

      for (let i = 0; i < data.length; i++) {
        access.write(wrap(offset + i, access.size, which), data[i]!)
      }

      return { space: which, address: offset, written: data.length }
    },

    'mem.fill': (raw) => {
      const params = asObject(raw, 'mem.fill')
      const which = space(params)
      const access = spaceAccess(machine, which)
      const offset = spaceOffset(params, which, resolveSymbol)
      const length = requireNumber(params, 'length')
      const value = requireNumber(params, 'value')

      if (!Number.isInteger(length) || length < 1) {
        throw invalidParams(`length: expected a positive integer, got ${length}`)
      }
      if (!Number.isInteger(value) || value < 0 || value > 0xff) {
        throw invalidParams(`value: expected a byte 0-255, got ${value}`)
      }

      for (let i = 0; i < length; i++) {
        access.write(wrap(offset + i, access.size, which), value)
      }

      return { space: which, address: offset, written: length }
    },

    'mem.search': (raw) => {
      const params = asObject(raw, 'mem.search')
      const which = space(params)
      const access = spaceAccess(machine, which)
      if (params.pattern === undefined) throw invalidParams('pattern is required')

      const pattern =
        typeof params.pattern === 'string' && !/^[A-Za-z0-9+/]*={0,2}$/.test(params.pattern)
          ? Uint8Array.from(Buffer.from(params.pattern, 'binary'))
          : toBytes(params.pattern, 'pattern')

      if (pattern.length === 0) throw invalidParams('pattern: must not be empty')

      const start = optionalNumber(params, 'start') ?? 0
      const end = optionalNumber(params, 'end') ?? access.size - 1
      const limit = optionalNumber(params, 'limit') ?? 64

      const matches: number[] = []
      const last = Math.min(end, access.size - 1) - pattern.length + 1

      for (let at = Math.max(0, start); at <= last && matches.length < limit; at++) {
        let hit = true
        for (let i = 0; i < pattern.length; i++) {
          if (access.read(at + i) !== pattern[i]) {
            hit = false
            break
          }
        }
        if (hit) matches.push(at)
      }

      return { space: which, matches, truncated: matches.length >= limit }
    },

    //
    // disasm
    //

    'disasm.at': (raw) => {
      const params = asObject(raw, 'disasm.at')
      const address = optionalAddress(params, 'address', resolveSymbol) ?? machine.cpu.pc
      const count = optionalNumber(params, 'count') ?? 8
      if (!Number.isInteger(count) || count < 1 || count > 4096) {
        throw invalidParams(`count: expected 1-4096, got ${count}`)
      }
      return {
        instructions: disassemble(
          { read: (at) => machine.peek(at) },
          address,
          count,
          target.symbols.resolver()
        ).map(instructionJSON)
      }
    },

    'disasm.range': (raw) => {
      const params = asObject(raw, 'disasm.range')
      const start = requireAddress(params, 'start', resolveSymbol)
      const end = requireAddress(params, 'end', resolveSymbol)
      if (end < start) throw invalidParams(`end ($${hex(end)}) is before start ($${hex(start)})`)
      return {
        instructions: disassembleRange(
          { read: (at) => machine.peek(at) },
          start,
          end,
          target.symbols.resolver()
        ).map(instructionJSON)
      }
    },

    //
    // sym
    //

    'sym.load': async (raw) => {
      const params = asObject(raw, 'sym.load')
      const path = optionalString(params, 'path')
      let text = optionalString(params, 'text')

      if (text === undefined) {
        if (path === undefined) throw invalidParams('sym.load: need "path" or "text"')
        if (!target.readTextFile) {
          throw notSupported('sym.load: this host cannot read files — pass "text" instead')
        }
        try {
          text = await target.readTextFile(path)
        } catch (e) {
          throw new RpcMethodError(
            ErrorCode.LOAD_FAILED,
            `sym.load: cannot read "${path}": ${(e as Error).message}`
          )
        }
      }

      const format = (oneOf(params, 'format', ['vice', 'ca65', 'lst'] as const) ??
        (path ? formatForPath(path) : 'vice')) as SymbolFormat

      const loaded = parseSymbols(text, format, path)
      if (optionalBoolean(params, 'merge') === false) target.symbols.clear()
      target.symbols.merge(loaded)

      // Conditions like `PC == main` resolve through the session, so keep it
      // pointed at the table rather than a snapshot of it.
      session.symbolResolver = resolveSymbol

      return { format, loaded: loaded.size, total: target.symbols.size }
    },

    'sym.lookup': (raw) => {
      const params = asObject(raw, 'sym.lookup')
      const address = requireAddress(params, 'address', resolveSymbol)
      const nearest = target.symbols.nearest(address)
      const line = target.symbols.lineFor(address)

      return {
        address,
        ...(nearest ? { name: nearest.symbol.name, offset: nearest.offset } : {}),
        ...(line ? { file: line.file, line: line.line } : {})
      }
    },

    'sym.resolve': (raw) => {
      const params = asObject(raw, 'sym.resolve')
      const name = requireString(params, 'name')
      const address = target.symbols.resolve(name)
      if (address === undefined) {
        throw invalidParams(`sym.resolve: no symbol named "${name}"`)
      }
      return { name, address }
    },

    'sym.list': (raw) => {
      const params = asObject(raw, 'sym.list')
      const prefix = optionalString(params, 'prefix')
      const limit = optionalNumber(params, 'limit') ?? 500

      const all = target.symbols
        .list()
        .filter((symbol) => prefix === undefined || symbol.name.startsWith(prefix))

      return {
        symbols: all.slice(0, limit).map((symbol) => ({
          name: symbol.name,
          address: symbol.address,
          ...(symbol.source ? { source: symbol.source } : {})
        })),
        total: all.length,
        truncated: all.length > limit
      }
    },

    //
    // media
    //

    'media.loadROM': async (raw) => {
      const params = asObject(raw, 'media.loadROM')
      const bytes = await mediaBytes(params, 'media.loadROM')
      if (bytes.length !== ROM.SIZE) {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadROM: ROM must be exactly ${ROM.SIZE} bytes, got ${bytes.length}`
        )
      }
      machine.loadROM(bytes)
      // The reset vectors just changed under the CPU; re-read them.
      session.reset(true)
      return { bytes: bytes.length, ...state() }
    },

    /**
     * Replace the Keypad Card's ROM with a freshly built KC Monitor image.
     *
     * Where 6502-EMULATOR has `media.loadCart`, and deliberately not named like
     * it: there is no cartridge slot on this machine and nothing to unload into.
     * This is the scripted equivalent of Settings → FILES → Keypad Card ROM —
     * how the firmware built in the sibling repository gets tested without
     * burning an AT28C64 — so it changes the machine's own firmware and, like
     * `media.loadROM`, resets afterwards to fetch the new image's vectors.
     */
    'media.loadCardROM': async (raw) => {
      const params = asObject(raw, 'media.loadCardROM')
      const bytes = await mediaBytes(params, 'media.loadCardROM')
      if (bytes.length !== CardROM.SIZE) {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadCardROM: the Keypad Card ROM must be exactly ${CardROM.SIZE} bytes, ` +
            `got ${bytes.length}`
        )
      }
      machine.loadCardROM(bytes)
      session.reset(true)
      return { bytes: bytes.length, ...state() }
    },

    'media.loadBinary': async (raw) => {
      const params = asObject(raw, 'media.loadBinary')
      const address = requireAddress(params, 'address', resolveSymbol)
      const bytes = await mediaBytes(params, 'media.loadBinary')

      const status = loadBinary(machine, address, bytes)
      if (status !== 'ok') {
        throw new RpcMethodError(
          ErrorCode.LOAD_FAILED,
          `media.loadBinary at $${hex(address)}: ${status}`
        )
      }
      return { address, bytes: bytes.length }
    },

    //
    // keypad
    //
    // The pad is the machine's own input, and on a KIM without a Serial Card it
    // is the only one. Where 6502-EMULATOR has input.key, input.joystick and
    // input.type, there is exactly this: the 74C922 reports one thing, a code,
    // and there is nothing else on the board to drive.
    //

    /**
     * Press one key on the pad, or a sequence of them.
     *
     * There is no `down` parameter and no release. The encoder reports the press
     * and nothing else — releases never reach the PIA on the real board — so
     * offering one would invent a signal the hardware does not send.
     *
     * A sequence is paced in emulated cycles rather than issued all at once, and
     * that is not politeness. The 74C922 latches a single code and raises DA;
     * the KC Monitor reads it in the CA1 interrupt handler and the read is what
     * clears the latch. Two presses with no emulated time between them means the
     * second overwrites the first before the handler has run, and the keystroke
     * is simply gone. Pacing at a plausible rate for a finger on a pad is what
     * makes a scripted keying-in reliable however fast the host is.
     */
    'keypad.press': async (raw) => {
      const params = asObject(raw, 'keypad.press')

      const requested = params.key ?? params.keys
      if (requested === undefined) {
        throw invalidParams('keypad.press: "key" is required — a key name, a code, or a list')
      }

      const wanted = Array.isArray(requested) ? requested : [requested]
      if (wanted.length === 0) throw invalidParams('key: the list is empty')

      const keys = wanted.map((entry): KeypadKey => {
        const key =
          typeof entry === 'number'
            ? keyForCode(entry)
            : typeof entry === 'string'
              ? keyForName(entry)
              : undefined
        if (!key) {
          throw invalidParams(
            `key: no key "${String(entry)}" on this pad — try one of ${keyNames().join(', ')}`
          )
        }
        return key
      })

      const pressed = (): Record<string, unknown>[] =>
        keys.map((key) => ({ code: key.code, label: key.label }))

      // One key needs no pacing and no running machine: it latches, and the
      // monitor picks it up whenever it next runs. Which makes `press` usable
      // from a paused machine, where most of a debugging session is spent.
      if (keys.length === 1) {
        machine.onKeypadDown(keys[0]!.code)
        return { keys: pressed() }
      }

      const kps = optionalNumber(params, 'kps') ?? 10
      if (!Number.isFinite(kps) || kps <= 0) {
        throw invalidParams(`kps: expected a positive number, got ${kps}`)
      }
      const cyclesPerKey = Math.max(1, Math.round(machine.frequency / kps))

      // Driven by the session's chunk cadence — the same clock the serial
      // console paces input on — so this costs nothing when nobody is keying and
      // stays correct at any host speed, turbo included.
      await new Promise<void>((resolve, reject) => {
        let index = 0
        let budget = 0
        let lastCycles = session.cycles

        const step = (): void => {
          budget += session.cycles - lastCycles
          lastCycles = session.cycles

          // One key per chunk, not as many as the budget can pay for. A chunk is
          // 20,000 cycles, so a fast `kps` would otherwise deliver the whole
          // sequence inside a single callback with no emulated time between the
          // presses at all — which is precisely the case the latch loses. The
          // chunk cadence is therefore the real ceiling and `kps` only slows
          // things further; both are wanted, because one guarantees the machine
          // ran and the other keeps the rate plausible for a finger on a pad.
          if (budget >= cyclesPerKey && index < keys.length) {
            budget -= cyclesPerKey
            machine.onKeypadDown(keys[index]!.code)
            index++
          }

          if (index >= keys.length) {
            off()
            resolve()
          }
        }

        const off = session.onChunk(step)

        // A paused machine would never see another chunk, and would take every
        // press onto the same latch. Keying into one is a caller mistake, not a
        // hang.
        if (!session.isRunning) {
          off()
          reject(invalidParams('keypad.press: the machine is paused — run it first'))
          return
        }

        step()
      })

      return { keys: pressed() }
    },

    /** Every key the pad has, so a client need not hard-code the table. */
    'keypad.map': () => ({
      keys: KEYPAD.map((key) => ({
        code: key.code,
        label: key.label,
        glyph: key.glyph,
        ...(key.value === undefined ? {} : { value: key.value }),
        row: key.row,
        col: key.col
      }))
    }),

    //
    // lcd
    //
    // Where 6502-EMULATOR reads the video card, this reads the 16x2 on the
    // Keypad LCD Helper — which on a KIM is not a secondary display but the
    // machine's own, the one the KC Monitor draws its address and byte on.
    //
    // There is no `lcd.png`. Sixteen by two characters is small enough to read
    // as text, and the pixel buffer is available whole for anything finer, so
    // the PNG encoder that screen.png needed does not come across.
    //

    'lcd.text': () => ({ lines: lcdLines() }),

    /**
     * CRC-32 of the pixel buffer — "has the panel changed", in one number.
     *
     * Over the pixels rather than the text because the cursor, the blink phase
     * and a CGRAM redefinition are all things the panel shows and DDRAM alone
     * does not.
     */
    'lcd.hash': () => {
      const lcd = machine.lcd
      lcd.updatePixels()
      return { hash: crc32(Uint8Array.from(lcd.buffer)).toString(16).padStart(8, '0') }
    },

    /**
     * The pixel buffer as the panel draws it, one byte per dot.
     *
     * `-1` is the gap between characters, `0` an unlit dot, `1` a lit one — and
     * the unlit dots matter, because on this display they are visible. Base64 of
     * the raw signed bytes, so `-1` arrives as 255.
     */
    'lcd.pixels': () => {
      const lcd = machine.lcd
      lcd.updatePixels()
      return {
        width: lcd.pixelsWidth,
        height: lcd.pixelsHeight,
        cols: lcd.cols,
        rows: lcd.rows,
        data: base64(Uint8Array.from(lcd.buffer))
      }
    },


    //
    // serial
    //

    'serial.write': (raw) => {
      const params = asObject(raw, 'serial.write')
      if (!target.writeSerial) {
        throw notSupported('serial.write: this machine has no serial console')
      }

      const encoding = oneOf(params, 'encoding', ['text', 'base64'] as const) ?? 'text'
      const data =
        encoding === 'base64'
          ? toBytes(requireString(params, 'data'), 'data')
          : toSerialNewlines(requireString(params, 'data'))

      // The cursor is taken before the write so a caller can pass it straight to
      // `wait.for {since}` and be certain of catching the reply, however many
      // cycles the machine gets through between the two calls.
      const cursor = target.readSerial?.({ since: Number.MAX_SAFE_INTEGER }).cursor
      lastWriteCursor = cursor

      target.writeSerial(data)
      return { queued: data.length, ...(cursor === undefined ? {} : { cursor }) }
    },

    'serial.read': (raw) => {
      const params = asObject(raw, 'serial.read')
      if (!target.readSerial) {
        throw notSupported('serial.read: this machine has no serial console')
      }
      const max = optionalNumber(params, 'max')
      const since = optionalNumber(params, 'since')
      const clear = optionalBoolean(params, 'clear') ?? false
      const read = target.readSerial({
        ...(max === undefined ? {} : { max }),
        ...(since === undefined ? {} : { since }),
        clear
      })
      return { data: read.data, length: read.data.length, cursor: read.cursor, truncated: read.truncated }
    },

    'serial.config': () => ({
      console: target.consoleMode(),
      ...(target.baudRate ? { baudRate: target.baudRate() } : {}),
      flowControl: machine.flowControl,
      frequency: machine.frequency
    }),

    //
    // state
    //
    // The biggest single speedup available to an agent loop: boot once, save at
    // the prompt, restore per test case instead of paying the BIOS countdown and
    // the LCD's ~1.8 M-cycle power-on ritual every time (§5.9).
    //

    /**
     * The whole machine, as JSON.
     *
     * Returned rather than written to a file because no host here has write
     * access — the headless target reads files and the renderer cannot even do
     * that without asking main. Whoever called this does have a filesystem, so
     * it is theirs to save.
     */
    'state.save': () => {
      const snapshot = captureSnapshot(machine)
      return {
        state: snapshot,
        version: snapshot.version,
        /** Roughly what saving it will cost on disk, so a caller can log it. */
        bytes: JSON.stringify(snapshot).length
      }
    },

    'state.load': async (raw) => {
      const params = asObject(raw, 'state.load')
      const path = optionalString(params, 'path')
      let snapshot: unknown = params.state

      if (snapshot === undefined || snapshot === null) {
        if (path === undefined) throw invalidParams('state.load: need "state" or "path"')
        if (!target.readTextFile) {
          throw notSupported('state.load: this host cannot read files — pass "state" instead')
        }
        let text: string
        try {
          text = await target.readTextFile(path)
        } catch (e) {
          throw new RpcMethodError(
            ErrorCode.LOAD_FAILED,
            `state.load: cannot read "${path}": ${(e as Error).message}`
          )
        }
        try {
          snapshot = JSON.parse(text)
        } catch (e) {
          throw new RpcMethodError(
            ErrorCode.LOAD_FAILED,
            `state.load: "${path}" is not valid JSON: ${(e as Error).message}`
          )
        }
      }

      const force = optionalBoolean(params, 'force') ?? false

      let restored: ReturnType<typeof restoreSnapshot> | undefined
      try {
        session.loadState(() => {
          restored = restoreSnapshot(machine, snapshot, { force })
        })
      } catch (e) {
        // A refusal before anything was written (wrong ROM, wrong slot layout)
        // and a failure part-way through a card both arrive here, and the client
        // cannot tell them apart from the message alone — so say what to do.
        if (e instanceof StateError) {
          throw new RpcMethodError(
            ErrorCode.LOAD_FAILED,
            `${e.message}. The machine may be in a partial state; session.reset to recover.`
          )
        }
        throw e
      }

      return {
        version: SNAPSHOT_VERSION,
        ...(restored?.romMismatch ? { romMismatch: restored.romMismatch } : {}),
        ...(restored?.cardROMMismatch ? { cardROMMismatch: restored.cardROMMismatch } : {}),
        ...state()
      }
    },

    //
    // wait
    //

    'wait.for': (raw) => waitFor(asObject(raw, 'wait.for'))
  }

  function setEnabled(params: Params, enabled: boolean): Record<string, unknown> {
    const id = requireNumber(params, 'id')
    if (!session.setBreakpointEnabled(id, enabled)) {
      throw invalidParams(`no breakpoint with id ${id}`)
    }
    return breakpointJSON(session.breakpoints.get(id)!)
  }

  /**
   * Block until something happens, or give up.
   *
   * The condition is checked on the session's chunk cadence rather than a
   * wall-clock timer, so `cycles` and `expression` are evaluated in emulated
   * time and land at the same point in a program however fast the host is.
   * Serial and stop conditions are event-driven and need no polling at all.
   */
  async function waitFor(params: Params): Promise<Record<string, unknown>> {
    const timeoutMs = optionalNumber(params, 'timeoutMs') ?? DEFAULT_WAIT_MS
    const serialPattern = optionalString(params, 'serial')
    const wantStop = optionalBoolean(params, 'stopped') ?? false
    const cycles = optionalNumber(params, 'cycles')
    const expression = optionalString(params, 'expression')

    if (!serialPattern && !wantStop && cycles === undefined && !expression) {
      throw invalidParams(
        'wait.for: need at least one of "serial", "stopped", "cycles" or "expression"'
      )
    }
    if (serialPattern && !target.onSerial) {
      throw notSupported('wait.for: this machine has no serial console')
    }

    const pattern = serialPattern ? toRegExp(serialPattern, 'serial') : undefined
    let compiled: ReturnType<typeof compileExpression> | undefined
    if (expression) {
      try {
        compiled = compileExpression(expression)
      } catch (e) {
        throw invalidParams(`expression: ${(e as Error).message}`)
      }
    }

    const startCycles = session.cycles
    const startedAt = Date.now()
    const mode = oneOf(params, 'run', ['realtime', 'turbo'] as const)

    // Look back to the last command sent unless told otherwise, so the reply to
    // it counts however long ago the machine printed it. An explicit `since` of
    // the current cursor is how a caller asks for strictly-new output instead.
    const since = optionalNumber(params, 'since') ?? lastWriteCursor
    const backlog =
      pattern && since !== undefined ? target.readSerial?.({ since }) : undefined
    let output = backlog?.data ?? ''

    return new Promise<Record<string, unknown>>((resolve) => {
      let settled = false
      const offs: (() => void)[] = []

      const finish = (reason: string, stop?: StopReason): void => {
        if (settled) return
        settled = true
        for (const off of offs) off()
        clearTimeout(timer)
        resolve({
          matched: reason !== 'timeout',
          reason,
          cycles: session.cycles,
          elapsedCycles: session.cycles - startCycles,
          elapsedMs: Date.now() - startedAt,
          ...(pattern ? { output } : {}),
          ...(backlog?.truncated ? { truncated: true } : {}),
          ...(stop ? { stop } : {}),
          ...state()
        })
      }

      const check = (): void => {
        if (settled) return
        if (cycles !== undefined && session.cycles - startCycles >= cycles) {
          finish('cycles')
          return
        }
        if (compiled) {
          let value = 0
          try {
            value = compiled({
              registers: {
                A: machine.cpu.a,
                X: machine.cpu.x,
                Y: machine.cpu.y,
                PC: machine.cpu.pc,
                SP: machine.cpu.sp,
                P: machine.cpu.st,
                ST: machine.cpu.st
              },
              read: (at) => machine.peek(at),
              symbol: resolveSymbol
            })
          } catch {
            // An expression that cannot be evaluated here — an unloaded symbol —
            // is not a match, and not a reason to abandon the other conditions.
            value = 0
          }
          if (value) finish('expression')
        }
      }

      const timer = setTimeout(() => finish('timeout'), timeoutMs)

      if (pattern && target.onSerial) {
        offs.push(
          target.onSerial((text) => {
            output += text
            if (pattern.test(output)) finish('serial')
          })
        )
      }
      if (wantStop) {
        offs.push(session.onStop((reason) => finish('stopped', reason)))
      }
      offs.push(session.onChunk(check))

      // Output the caller asked us to look back over may already satisfy the
      // pattern, in which case there is nothing to wait for.
      if (pattern && output && pattern.test(output)) {
        finish('serial')
        return
      }

      // A machine that has *already* stopped satisfies `stopped` — and for a
      // one-shot caller that is the normal case, not an edge one. In turbo the
      // machine covers hundreds of thousands of cycles between two `6502-kim dbg`
      // processes, so a breakpoint armed by one command has usually fired long
      // before the next command connects to wait for it; listening only for a
      // future stop would time out while the machine sat there stopped. This is
      // the same race the console stream needed a cursor for (§5.13).
      //
      // Not when the caller also asked to run, though: `--stopped --run turbo`
      // means "continue, and tell me when it stops again", so the stop it is
      // waiting for is by definition the next one.
      if (wantStop && !mode && !session.isRunning) {
        finish('stopped', session.lastStop ?? { kind: 'paused' })
        return
      }

      if (mode) session.run(mode)

      // An already-satisfied condition should return at once rather than after a
      // chunk's worth of emulated time — or, if the machine is paused, never.
      check()
    })
  }
}

/**
 * Wrap an offset into its space.
 *
 * The CPU space wraps at 64K because that is what the address bus does. The
 * image spaces refuse instead: running off the end of the BIOS or the Keypad
 * Card's ROM is a mistake, and silently reading from the start would hide it.
 */
function wrap(offset: number, size: number, space: MemorySpace): number {
  if (space === 'cpu') return offset & 0xffff
  if (offset >= size) {
    throw invalidParams(`address: ${offset} is past the end of ${space} (${size} bytes)`)
  }
  return offset
}

const hex = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0')

/**
 * Translate line endings for the serial console.
 *
 * Pressing Enter on a terminal transmits CR, and the KC Monitor's serial monitor
 * ends a line on CR alone — an LF is accepted as input but never submits, so
 * `serial.write` of "0800\n" would type the address and leave it at the prompt.
 */
function toSerialNewlines(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) & 0xff
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) continue
    out.push(code === 0x0a ? 0x0d : code)
  }
  return Uint8Array.from(out)
}
