import { Session } from '../../../debug/Session'
import { ACIA } from '../../../core/IO/ACIA'
import { Empty } from '../../../core/IO/Empty'
import { CardROM } from '../../../core/CardROM'
import {
  LCD_CMD_CLEAR,
  LCD_CMD_DISPLAY,
  LCD_CMD_DISPLAY_ON,
  LCD_CMD_FUNCTION,
  LCD_CMD_FUNCTION_LCD_2LINE
} from '../../../core/IO/Attachments/LCDAttachment'
import { SymbolTable } from '../../../debug/symbols/Symbols'
import { createMethods } from '../../../debug/server/Methods'
import type { MethodTable } from '../../../debug/server/Methods'
import { ErrorCode, RpcMethodError } from '../../../debug/server/Protocol'
import type { DebugTarget, SerialRead } from '../../../debug/server/DebugTarget'

/**
 * A target with no sockets and no filesystem.
 *
 * The method table is the whole protocol surface, so testing it directly —
 * rather than through HTTP — is where the behaviour actually gets covered.
 */
function target(options: { console?: 'serial' | 'keypad'; serial?: boolean } = {}): {
  target: DebugTarget
  methods: MethodTable
  session: Session
  emit: (text: string) => void
  written: string[]
} {
  const consoleMode = options.console ?? 'serial'
  // The KIM's own layout: io5 holds the Serial Card, and taking it out is what
  // makes a keypad-only machine — the configuration the KC Monitor guards every
  // ACIA access for.
  const session = new Session({ io5: consoleMode === 'keypad' ? new Empty() : new ACIA() })

  let stream = ''
  const listeners = new Set<(text: string) => void>()
  const written: string[] = []

  const base: DebugTarget = {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '9.9.9',
    consoleMode: () => consoleMode
  }

  const withSerial: DebugTarget = {
    ...base,
    writeSerial: (data) => written.push(Buffer.from(data).toString('binary')),
    readSerial: ({ since, max, clear }): SerialRead => {
      let text = since === undefined ? stream : stream.slice(Math.min(since, stream.length))
      if (max !== undefined) text = text.slice(-max)
      if (clear) stream = ''
      return { data: text, cursor: stream.length, truncated: false }
    },
    onSerial: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    baudRate: () => 19200,
    setBaudRate: () => {}
  }

  const chosen = options.serial === false ? base : withSerial

  return {
    target: chosen,
    methods: createMethods(chosen),
    session,
    emit: (text) => {
      stream += text
      for (const listener of listeners) listener(text)
    },
    written
  }
}

/**
 * Assemble bytes into ROM at `at` and point the reset vector there.
 *
 * Programs live at $A000, in the Kernal window — the part of `BIOS.bin` the
 * Keypad Card leaves reachable. Not at $C000, where 6502-EMULATOR puts them:
 * on a KIM that is the PIA, mirrored every four bytes, and a "program" written
 * there would be a sequence of writes to a 65C21.
 *
 * The reset vector goes into the Keypad Card's ROM rather than the BIOS, because
 * the card overlays $E000-$FFFF and $FFFC of `BIOS.bin` is not on the bus.
 */
function program(session: Session, at: number, ...bytes: number[]): void {
  const rom = new Array(0x8000).fill(0xea)
  bytes.forEach((byte, i) => {
    rom[at - 0x8000 + i] = byte
  })
  session.machine.loadROM(rom)

  const card = new Array(CardROM.SIZE).fill(0xea)
  card[0xfffc - CardROM.START] = at & 0xff
  card[0xfffd - CardROM.START] = (at >> 8) & 0xff
  session.machine.loadCardROM(card)

  session.machine.reset(true)
}

/** The error a call rejects with, so a test can assert on its code. */
async function errorOf(call: () => unknown): Promise<RpcMethodError> {
  try {
    await call()
  } catch (e) {
    return e as RpcMethodError
  }
  throw new Error('expected the call to fail')
}

describe('session', () => {
  it('reports what the machine is', () => {
    const { methods } = target()
    expect(methods['session.info']!({})).toMatchObject({
      protocol: 1,
      host: 'test',
      version: '9.9.9',
      console: 'serial',
      frequency: 1_000_000,
      serialCard: true,
      mode: 'paused',
      running: false
    })
  })

  // Where 6502-EMULATOR reports whether a cartridge is in. There is no cartridge
  // here — the Keypad Card is soldered in — but whether io5 is fitted is a real
  // question about this machine, and the answer changes which methods work.
  it('reports a keypad-only machine as having no Serial Card', () => {
    const { methods } = target({ console: 'keypad', serial: false })
    expect(methods['session.info']!({})).toMatchObject({
      console: 'keypad',
      serialCard: false
    })
  })

  it('changes the clock, and refuses one the hardware has no jumper for', async () => {
    const { methods, session } = target()

    methods['session.config']!({ frequency: 2_000_000 })
    expect(session.machine.frequency).toBe(2_000_000)

    const error = await errorOf(() => methods['session.config']!({ frequency: 3_000_000 }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('resets', () => {
    const { methods, session } = target()
    session.machine.cpu.a = 0x42
    methods['session.reset']!({ cold: true })
    expect(session.machine.cpu.a).toBe(0)
  })
})

describe('exec', () => {
  it('steps one instruction at a time', () => {
    const { methods, session } = target()
    program(session, 0xa000, 0xa9, 0x42) // LDA #$42

    const result = methods['exec.step']!({}) as { registers: { PC: number; A: number } }
    expect(result.registers.PC).toBe(0xa002)
    expect(result.registers.A).toBe(0x42)
  })

  it('steps a requested number of times', () => {
    const { methods, session } = target()
    program(session, 0xa000)
    methods['exec.step']!({ count: 4 })
    expect(session.machine.cpu.pc).toBe(0xa004)
  })

  it('runs an exact cycle budget', () => {
    const { methods, session } = target()
    program(session, 0xa000)

    const result = methods['exec.runCycles']!({ cycles: 1000 }) as { stop: unknown }
    expect(result.stop).toEqual({ kind: 'cycle-budget', cycles: 1000 })
    expect(session.cycles).toBe(1000)
  })

  it('rejects a step count that is not a positive whole number', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['exec.step']!({ count: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    expect((await errorOf(() => methods['exec.step']!({ count: 1.5 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('runs to an address', async () => {
    const { methods, session } = target()
    program(session, 0xa000)

    const result = (await methods['exec.runTo']!({ address: 0xa010 })) as {
      stop: { kind: string; address: number }
    }
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xa010 })
    expect(session.machine.cpu.pc).toBe(0xa010)
  })

  // Otherwise run-to-cursor inside a loop would return immediately, every time,
  // having executed nothing.
  it('runs a full lap when already sitting on the target', async () => {
    const { methods, session } = target()
    // $A000 NOP; $A001 JMP $A000
    program(session, 0xa000, 0xea, 0x4c, 0x00, 0xa0)
    expect(session.machine.cpu.pc).toBe(0xa000)

    const before = session.cycles
    await methods['exec.runTo']!({ address: 0xa000 })
    expect(session.machine.cpu.pc).toBe(0xa000)
    expect(session.cycles).toBeGreaterThan(before)
  })

  it('gives up on an address never reached, leaving no breakpoint behind', async () => {
    const { methods, session } = target()
    program(session, 0xa000, 0x4c, 0x00, 0xa0) // JMP $A000, forever

    const result = (await methods['exec.runTo']!({
      address: 0xd000,
      timeoutMs: 100
    })) as { stop: { kind: string } }

    expect(result.stop.kind).toBe('paused')
    expect(session.breakpoints.list()).toHaveLength(0)
  })
})

describe('bp', () => {
  it('sets, lists, disables and clears', () => {
    const { methods } = target()

    const set = methods['bp.set']!({ address: '0xA000' }) as { id: number; address: number }
    expect(set.address).toBe(0xa000)

    expect(methods['bp.list']!({})).toMatchObject({ breakpoints: [{ id: set.id }] })

    expect(methods['bp.disable']!({ id: set.id })).toMatchObject({ enabled: false })
    expect(methods['bp.enable']!({ id: set.id })).toMatchObject({ enabled: true })

    expect(methods['bp.clear']!({})).toEqual({ cleared: 1 })
    expect(methods['bp.list']!({})).toEqual({ breakpoints: [] })
  })

  it('accepts a symbol as the address', () => {
    const { methods, target: t } = target()
    t.symbols.add({ name: 'main', address: 0xa123 })
    expect(methods['bp.set']!({ address: 'main' })).toMatchObject({ address: 0xa123 })
  })

  // A condition that will not compile has to be reported as the caller's
  // mistake, not swallowed into a breakpoint that then never fires.
  it('reports a malformed condition as a parameter error', async () => {
    const { methods } = target()
    const error = await errorOf(() => methods['bp.set']!({ address: 0xa000, condition: 'A ==' }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
    expect(error.message).toMatch(/condition/)
  })

  it('refuses to enable a breakpoint that does not exist', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['bp.enable']!({ id: 99 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('reg', () => {
  it('reads registers with the flags broken out', () => {
    const { methods, session } = target()
    session.machine.cpu.a = 0x80
    session.machine.cpu.st = 0b10000001

    expect(methods['reg.get']!({})).toMatchObject({
      A: 0x80,
      flags: { N: true, C: true, Z: false }
    })
  })

  it('writes registers', () => {
    const { methods, session } = target()
    methods['reg.set']!({ A: 0x12, X: 0x34, PC: '0xA000' })

    expect(session.machine.cpu.a).toBe(0x12)
    expect(session.machine.cpu.x).toBe(0x34)
    expect(session.machine.cpu.pc).toBe(0xa000)
  })

  // Setting the PC mid-instruction would otherwise let the CPU finish the old
  // one against the new address and execute a spliced-together opcode.
  it('abandons the instruction in flight when the PC moves', () => {
    const { methods, session } = target()
    program(session, 0xa000, 0xad, 0x00, 0x04) // LDA $0400, a 4-cycle instruction
    session.machine.tick()
    expect(session.machine.cpu.cyclesRem).toBeGreaterThan(0)

    methods['reg.set']!({ PC: 0xa100 })
    expect(session.machine.cpu.cyclesRem).toBe(0)
  })

  it('rejects a byte that is not one', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['reg.set']!({ A: 256 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('mem', () => {
  const decode = (result: unknown): number[] => [
    ...Buffer.from((result as { data: string }).data, 'base64')
  ]

  it('writes and reads back', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x0300, data: [0xde, 0xad, 0xbe, 0xef] })
    expect(decode(methods['mem.read']!({ address: 0x0300, length: 4 }))).toEqual([
      0xde, 0xad, 0xbe, 0xef
    ])
  })

  it('accepts base64 as well as an array', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x0300, data: Buffer.from([1, 2, 3]).toString('base64') })
    expect(decode(methods['mem.read']!({ address: 0x0300, length: 3 }))).toEqual([1, 2, 3])
  })

  it('fills', () => {
    const { methods } = target()
    methods['mem.fill']!({ address: 0x0400, length: 16, value: 0xaa })
    expect(decode(methods['mem.read']!({ address: 0x040f, length: 1 }))).toEqual([0xaa])
  })

  it('searches', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0x1234, data: [0xca, 0xfe] })
    expect(methods['mem.search']!({ space: 'ram', pattern: [0xca, 0xfe] })).toMatchObject({
      matches: [0x1234]
    })
  })

  it('wraps the CPU space at 64K, as the address bus does', () => {
    const { methods } = target()
    methods['mem.write']!({ address: 0xffff, data: [0x11, 0x22] })
    // The second byte lands at $0000, not past the end of memory.
    expect(decode(methods['mem.read']!({ address: 0x0000, length: 1 }))).toEqual([0x22])
  })

  /**
   * The top of `BIOS.bin` is not on this machine's bus at all — the Keypad Card
   * overlays it — so the `rom` space is the only way to see it. A CPU-space read
   * of $E000 answers out of the card, which is the machine working correctly and
   * not what someone inspecting the BIOS image asked for.
   */
  it('reaches the part of the BIOS the card overlays', () => {
    const { methods } = target()

    methods['mem.write']!({ space: 'rom', address: 0xe000 - 0x8000, data: [0x5a] })
    expect(decode(methods['mem.read']!({ space: 'rom', address: 0xe000 - 0x8000, length: 1 })))
      .toEqual([0x5a])
    expect(decode(methods['mem.read']!({ address: 0xe000, length: 1 }))).not.toEqual([0x5a])
  })

  it('patches the Keypad Card ROM, which is where the firmware under test lives', () => {
    const { methods, session } = target()

    methods['mem.write']!({ space: 'card', address: 0x0100, data: [0x99] })
    expect(session.machine.peek(CardROM.START + 0x0100)).toBe(0x99)
    expect(decode(methods['mem.read']!({ space: 'card', address: 0x0100, length: 1 })))
      .toEqual([0x99])
  })

  // Writes through the CPU space are ignored above $8000, exactly as on the
  // hardware, so patching a ROM image needs its own space.
  it('patches the ROM image, which a CPU-space write cannot', () => {
    const { methods } = target()

    methods['mem.write']!({ address: 0xb000, data: [0x99] })
    expect(decode(methods['mem.read']!({ address: 0xb000, length: 1 }))).not.toEqual([0x99])

    methods['mem.write']!({ space: 'rom', address: 0xb000 - 0x8000, data: [0x99] })
    expect(decode(methods['mem.read']!({ address: 0xb000, length: 1 }))).toEqual([0x99])
  })

  it('refuses to run off the end of an image space', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['mem.read']!({ space: 'card', address: CardROM.SIZE - 4, length: 16 })
    )
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('rejects an unknown space and a bad length', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['mem.read']!({ space: 'tape', address: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    expect((await errorOf(() => methods['mem.read']!({ address: 0, length: 0 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  // The debugger must not trip the watchpoints the program set — they exist to
  // catch what the program does, not what the person inspecting it does.
  it('does not fire a watchpoint', () => {
    const { methods, session } = target()
    session.addBreakpoint({ kind: 'access', address: 0x0400 })

    const stops: unknown[] = []
    session.onStop((reason) => stops.push(reason))

    methods['mem.read']!({ address: 0x0400, length: 1 })
    methods['mem.write']!({ address: 0x0400, data: [1] })
    expect(stops).toHaveLength(0)
  })
})

describe('disasm', () => {
  it('decodes from the PC by default', () => {
    const { methods, session } = target()
    program(session, 0xa000, 0xa9, 0x42, 0xea)

    const result = methods['disasm.at']!({ count: 2 }) as {
      instructions: { address: number; name: string; text: string }[]
    }
    expect(result.instructions[0]).toMatchObject({ address: 0xa000, name: 'LDA' })
    expect(result.instructions[0]!.text).toContain('LDA #$42')
    expect(result.instructions[1]).toMatchObject({ address: 0xa002, name: 'NOP' })
  })

  it('names a target it has a symbol for', () => {
    const { methods, session, target: t } = target()
    t.symbols.add({ name: 'Chrout', address: 0xa800 })
    program(session, 0xa000, 0x20, 0x00, 0xa8) // JSR $A800

    const result = methods['disasm.at']!({ count: 1 }) as {
      instructions: { label?: string; text: string }[]
    }
    expect(result.instructions[0]!.label).toBe('Chrout')
    expect(result.instructions[0]!.text).toContain('JSR Chrout')
  })

  it('decodes a range', () => {
    const { methods, session } = target()
    program(session, 0xa000)
    const result = methods['disasm.range']!({ start: 0xa000, end: 0xa003 }) as {
      instructions: unknown[]
    }
    expect(result.instructions).toHaveLength(4)
  })

  it('refuses a range that runs backwards', async () => {
    const { methods } = target()
    expect(
      (await errorOf(() => methods['disasm.range']!({ start: 0xa010, end: 0xa000 }))).code
    ).toBe(ErrorCode.INVALID_PARAMS)
  })
})

describe('sym', () => {
  it('loads VICE labels from text and resolves both ways', async () => {
    const { methods, session } = target()

    expect(
      await methods['sym.load']!({ text: 'al C:A000 .main\nal C:A800 .Chrout\n' })
    ).toMatchObject({
      format: 'vice',
      loaded: 2
    })

    expect(methods['sym.resolve']!({ name: 'main' })).toEqual({ name: 'main', address: 0xa000 })
    expect(methods['sym.lookup']!({ address: 0xa007 })).toMatchObject({ name: 'main', offset: 7 })

    // Loaded symbols become available to breakpoint conditions too.
    expect(session.symbolResolver?.('Chrout')).toBe(0xa800)
  })

  it('lists with a prefix', async () => {
    const { methods } = target()
    await methods['sym.load']!({ text: 'al C:A000 .main\nal C:A010 .mainLoop\nal C:B000 .other\n' })

    expect(methods['sym.list']!({ prefix: 'main' })).toMatchObject({ total: 2 })
  })

  /**
   * The KC Monitor ships a listing and no debug file, so a KIM session that
   * could not read one would have symbols for the BIOS and none at all for the
   * firmware it is most likely to be stepping through.
   */
  it('loads a ca65 listing, placing labels by their segment', async () => {
    const { methods } = target()

    const listing = [
      'ca65 V2.19 - Git 0fca83500',
      '',
      '000000r 1               Beep                := $A030',
      '000000r 1               .segment "ROM"',
      '000000r 1               CartReset:',
      '000000r 1  78             sei',
      '000042r 1               @WaitStart:',
      '00004Dr 1               WarmStart:'
    ].join('\n')

    expect(await methods['sym.load']!({ text: listing, format: 'lst' })).toMatchObject({
      format: 'lst',
      loaded: 4
    })

    // A label takes the location counter, offset by where its segment links.
    expect(methods['sym.resolve']!({ name: 'CartReset' })).toMatchObject({ address: 0xe000 })
    expect(methods['sym.resolve']!({ name: 'WarmStart' })).toMatchObject({ address: 0xe04d })
    // An equate takes its right-hand side. Reading the column instead would put
    // the whole Kernal API at $E000.
    expect(methods['sym.resolve']!({ name: 'Beep' })).toMatchObject({ address: 0xa030 })
    // Cheap locals are qualified, because there are a dozen @Done's in the ROM.
    expect(methods['sym.resolve']!({ name: 'CartReset@WaitStart' })).toMatchObject({
      address: 0xe042
    })
  })

  it('picks the format from the extension, .lst as well as .dbg', async () => {
    const { methods, target: t } = target()
    ;(t as { readTextFile?: (path: string) => string }).readTextFile = () =>
      '000000r 1               .segment "ROM"\n000010r 1               MonitorLoop:\n'

    expect(await methods['sym.load']!({ path: 'KC Monitor.lst' })).toMatchObject({ format: 'lst' })
    expect(methods['sym.resolve']!({ name: 'MonitorLoop' })).toMatchObject({ address: 0xe010 })
  })

  it('reports an unknown name rather than guessing an address', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['sym.resolve']!({ name: 'nope' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  // A host with no filesystem — the renderer, in Phase 7 — has to say so rather
  // than fail in some other way.
  it('says so when it cannot read files', async () => {
    const { methods } = target()
    const error = await errorOf(() => methods['sym.load']!({ path: '/tmp/nope.lbl' }))
    expect(error.code).toBe(ErrorCode.NOT_SUPPORTED)
  })
})

describe('serial', () => {
  it('queues text, translating newlines to what a terminal sends', () => {
    const { methods, written } = target()
    methods['serial.write']!({ data: '0800\n' })
    // The monitor ends a line on CR; an LF would type it and leave it there.
    expect(written[0]).toBe('0800\r')
  })

  it('collapses CRLF so a Windows-authored script does not submit twice', () => {
    const { methods, written } = target()
    methods['serial.write']!({ data: '0800R\r\n' })
    expect(written[0]).toBe('0800R\r')
  })

  it('sends base64 through untouched', () => {
    const { methods, written } = target()
    methods['serial.write']!({
      data: Buffer.from([0x1b, 0x0a]).toString('base64'),
      encoding: 'base64'
    })
    expect(written[0]).toBe('\x1b\n')
  })

  it('reads back what the machine printed', () => {
    const { methods, emit } = target()
    emit('\\\r\n')
    expect(methods['serial.read']!({})).toMatchObject({ data: '\\\r\n' })
  })

  // The keypad-only machine: io5 is vacant, so there is no ACIA to write to.
  it('says so when the machine has no Serial Card', async () => {
    const { methods } = target({ console: 'keypad', serial: false })
    expect((await errorOf(() => methods['serial.write']!({ data: 'x' }))).code).toBe(
      ErrorCode.NOT_SUPPORTED
    )
  })
})

describe('wait.for', () => {
  it('matches output that arrives after the call', async () => {
    const { methods, emit } = target()
    const pending = methods['wait.for']!({ serial: 'OK', timeoutMs: 2000 })

    emit('OK\r\n')
    expect(await pending).toMatchObject({ matched: true, reason: 'serial' })
  })

  /**
   * The case that makes one-shot CLI calls usable at all.
   *
   * Between a `serial.write` process and a `wait.for` process the machine can
   * run hundreds of thousands of cycles in turbo, so the reply is normally
   * already printed before the wait exists. Defaulting to the cursor recorded
   * at the last write is what stops that being a lost race.
   */
  it('finds a reply that was already printed before the wait started', async () => {
    const { methods, emit } = target()

    methods['serial.write']!({ data: '0800\n' })
    emit('0800\r\n0800: EA\r\n\\\r\n')

    const result = (await methods['wait.for']!({ serial: '\\\\', timeoutMs: 500 })) as {
      matched: boolean
      output: string
    }
    expect(result.matched).toBe(true)
    expect(result.output).toContain('0800: EA')
  })

  it('does not match output from before the point asked for', async () => {
    const { methods, emit } = target()
    emit('OK\r\n')

    // since = the end of the stream, i.e. strictly new output only.
    const result = (await methods['wait.for']!({
      serial: 'OK',
      since: 4,
      timeoutMs: 200
    })) as { matched: boolean }
    expect(result.matched).toBe(false)
  })

  it('reports a timeout rather than failing', async () => {
    const { methods } = target()
    expect(await methods['wait.for']!({ serial: 'never', timeoutMs: 100 })).toMatchObject({
      matched: false,
      reason: 'timeout'
    })
  })

  it('waits for a cycle budget, measured in emulated time', async () => {
    const { methods, session } = target()
    program(session, 0xa000)

    const result = (await methods['wait.for']!({
      cycles: 50_000,
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string; elapsedCycles: number }

    expect(result.reason).toBe('cycles')
    expect(result.elapsedCycles).toBeGreaterThanOrEqual(50_000)
    session.pause()
  })

  it('waits for an expression over the machine state', async () => {
    const { methods, session } = target()
    // LDX #0; INX; JMP $A002 — X climbs until it wraps.
    program(session, 0xa000, 0xa2, 0x00, 0xe8, 0x4c, 0x02, 0xa0)

    const result = (await methods['wait.for']!({
      expression: 'X > 100',
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string }

    expect(result.reason).toBe('expression')
    session.pause()
  })

  it('waits for the machine to stop', async () => {
    const { methods, session } = target()
    program(session, 0xa000)
    session.addBreakpoint({ address: 0xa010 })

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string; stop: { kind: string; address: number } }

    expect(result.reason).toBe('stopped')
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xa010 })
  })

  /**
   * The `stopped` counterpart to the serial-cursor case above, and it bit a
   * worked example before it bit a user: a breakpoint armed by one `6502-kim dbg`
   * process fires while the *next* one is still starting up, so a wait that only
   * listened for a future stop timed out with the machine sitting there stopped.
   */
  it('reports a stop that already happened, with the reason it happened for', async () => {
    const { methods, session } = target()
    program(session, 0xa000)
    session.addBreakpoint({ address: 0xa010 })

    // Run to the breakpoint first, so the stop is in the past by the time the
    // wait is set up — exactly what a separate process would find.
    await methods['wait.for']!({ stopped: true, run: 'turbo', timeoutMs: 5000 })
    expect(session.isRunning).toBe(false)

    const result = (await methods['wait.for']!({ stopped: true, timeoutMs: 200 })) as {
      matched: boolean
      reason: string
      stop: { kind: string; address: number }
    }

    expect(result.matched).toBe(true)
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: 0xa010 })
  })

  it('reports a machine that was simply never started as paused', async () => {
    const { methods } = target()
    const result = (await methods['wait.for']!({ stopped: true, timeoutMs: 200 })) as {
      matched: boolean
      stop: { kind: string }
    }
    expect(result).toMatchObject({ matched: true, stop: { kind: 'paused' } })
  })

  /**
   * `--stopped --run turbo` means "continue, and tell me when it stops again",
   * so the already-stopped shortcut must not short-circuit it — otherwise
   * resuming from a breakpoint would return instantly without running.
   */
  it('runs first when asked to, rather than answering with the stop it is leaving', async () => {
    const { methods, session } = target()
    program(session, 0xa000)
    session.addBreakpoint({ address: 0xa010 })

    await methods['wait.for']!({ stopped: true, run: 'turbo', timeoutMs: 5000 })
    const stoppedAt = session.cycles

    // Ahead of where it stopped: the program is NOPs climbing through the
    // address space, so a breakpoint behind the PC would never be reached.
    session.breakpoints.clear()
    session.addBreakpoint({ address: 0xa020 })

    const result = (await methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { stop: { address: number } }

    expect(result.stop.address).toBe(0xa020)
    expect(session.cycles).toBeGreaterThan(stoppedAt)
  })

  it('insists on being given something to wait for', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['wait.for']!({ timeoutMs: 100 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('rejects a pattern that will not compile', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['wait.for']!({ serial: '[' }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('media', () => {
  it('refuses a ROM that is not exactly 32K', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['media.loadROM']!({ data: Buffer.alloc(1024).toString('base64') })
    )
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
  })

  /**
   * A new BIOS does not move the reset vector on this machine, and that is the
   * decode working. $FFFC belongs to the Keypad Card, so where a KIM starts is
   * the card's business whatever image is in the BIOS socket.
   */
  it('loads a ROM without disturbing where the machine starts', async () => {
    const { methods, session } = target()
    program(session, 0xa000)

    const rom = Buffer.alloc(0x8000, 0xea)
    rom[0xfffc - 0x8000] = 0x34
    rom[0xfffd - 0x8000] = 0xb2

    await methods['media.loadROM']!({ data: rom.toString('base64') })
    expect(session.machine.cpu.pc).toBe(0xa000)
  })

  it('refuses a Keypad Card ROM that is not exactly 8K', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['media.loadCardROM']!({ data: Buffer.alloc(0x8000).toString('base64') })
    )
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/8192 bytes/)
  })

  it('loads a Keypad Card ROM and re-reads its vectors', async () => {
    const { methods, session } = target()
    const card = Buffer.alloc(CardROM.SIZE, 0xea)
    card[0xfffc - CardROM.START] = 0x34
    card[0xfffd - CardROM.START] = 0xf2

    const result = (await methods['media.loadCardROM']!({ data: card.toString('base64') })) as {
      bytes: number
    }

    expect(result.bytes).toBe(CardROM.SIZE)
    expect(session.machine.cpu.pc).toBe(0xf234)
  })

  it('has no cartridge to load or unload', () => {
    const { methods } = target()
    expect(methods['media.loadCart']).toBeUndefined()
    expect(methods['media.unloadCart']).toBeUndefined()
  })

  it('loads raw bytes at an address', async () => {
    const { methods, session } = target()
    await methods['media.loadBinary']!({ address: 0x2000, data: [1, 2, 3] })
    expect(session.machine.peek(0x2000)).toBe(1)
    expect(session.machine.peek(0x2002)).toBe(3)
  })

  it('refuses raw bytes that will not fit in RAM', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['media.loadBinary']!({ address: 0xa000, data: [1, 2, 3] })
    )
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
  })

  it('needs either a path or inline data', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['media.loadBinary']!({ address: 0x2000 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})

describe('keypad', () => {
  it('presses a key by name, by glyph or by encoder code', async () => {
    const { methods, session } = target()

    expect(await methods['keypad.press']!({ key: '7' })).toEqual({
      keys: [{ code: 0x07, label: '7' }]
    })
    expect(session.machine.keypad.getCurrentKey()).toBe(0x07)

    // The name and the code reach the same switch, which is the whole point of
    // there being one KeypadMap.
    await methods['keypad.press']!({ key: 0x0a })
    expect(session.machine.keypad.getCurrentKey()).toBe(0x0a)
    expect(await methods['keypad.press']!({ key: '0' })).toEqual({
      keys: [{ code: 0x0a, label: '0' }]
    })
  })

  /**
   * The trap the encoder sets for anyone who assumes the obvious.
   *
   * `0` is code $0A, not $00 — $00 is the left arrow — and `C` to `F` run
   * backwards. A press method that derived the code from the digit would key in
   * the wrong address on the very first `0` a script typed.
   */
  it('sends the encoder code, which is not the key value', async () => {
    const { methods, session } = target()

    await methods['keypad.press']!({ key: '0' })
    expect(session.machine.keypad.getCurrentKey()).toBe(0x0a)

    await methods['keypad.press']!({ key: 'C' })
    expect(session.machine.keypad.getCurrentKey()).toBe(0x0f)

    await methods['keypad.press']!({ key: 'LEFT' })
    expect(session.machine.keypad.getCurrentKey()).toBe(0x00)
  })

  // No `down`, and no release: the 74C922 reports the press and nothing else.
  it('takes no release, because the hardware sends none', async () => {
    const { methods } = target()
    const result = (await methods['keypad.press']!({ key: 'ESC' })) as { keys: unknown[] }
    expect(result).not.toHaveProperty('down')
    expect(result.keys).toHaveLength(1)
  })

  it('presses a single key on a paused machine', async () => {
    const { methods, session } = target()
    expect(session.isRunning).toBe(false)
    await methods['keypad.press']!({ key: 'INS' })
    expect(session.machine.keypad.hasDataReady()).toBe(true)
  })

  /**
   * The reason a sequence is paced rather than issued at once.
   *
   * The encoder latches one code. Without emulated time between two presses the
   * second overwrites the first before the CA1 handler has read it, and the
   * keystroke is gone — so a sequence issued instantaneously would deliver only
   * its last key however long the list was.
   */
  it('paces a sequence, leaving emulated time between one press and the next', async () => {
    const { methods, session } = target()
    // A handler that reads PORTA every time round, which is what clears the
    // latch on the real card: LDA $C000; JMP $A000.
    program(session, 0xa000, 0xad, 0x00, 0xc0, 0x4c, 0x00, 0xa0)

    // When each press landed, in emulated cycles. Two presses at the same cycle
    // would mean the second overwrote a latch nothing had read.
    const at: number[] = []
    jest.spyOn(session.machine, 'onKeypadDown').mockImplementation((code: number) => {
      at.push(session.cycles)
      session.machine.keypad.press(code)
    })

    session.run('turbo')
    const result = (await methods['keypad.press']!({
      keys: ['0', '8', '0', '0'],
      kps: 2000
    })) as { keys: { code: number }[] }
    session.pause()

    expect(result.keys.map((k) => k.code)).toEqual([0x0a, 0x08, 0x0a, 0x0a])
    expect(at).toHaveLength(4)
    for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!)
  })

  it('refuses to key into a paused machine rather than hanging forever', async () => {
    const { methods, session } = target()
    program(session, 0xa000)
    expect((await errorOf(() => methods['keypad.press']!({ keys: ['1', '2'] }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    void session
  })

  it('rejects a key that is not on this pad, and lists the ones that are', async () => {
    const { methods } = target()
    const error = await errorOf(() => methods['keypad.press']!({ key: 'G' }))
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
    expect(error.message).toMatch(/ESC/)

    // $18 and up: the encoder has 24 switches and no more.
    expect((await errorOf(() => methods['keypad.press']!({ key: 0x18 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('needs a key', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['keypad.press']!({}))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
    expect((await errorOf(() => methods['keypad.press']!({ keys: [] }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('reports the whole pad, so a client need not hard-code it', () => {
    const { methods } = target()
    const map = methods['keypad.map']!({}) as {
      keys: { code: number; label: string; value?: number }[]
    }

    expect(map.keys).toHaveLength(24)
    expect(map.keys.find((k) => k.label === '0')).toMatchObject({ code: 0x0a, value: 0x00 })
    // The eight command keys have no value, which is what the panel colours by.
    expect(map.keys.filter((k) => k.value === undefined)).toHaveLength(8)
  })
})

describe('lcd', () => {
  /**
   * Put text on the glass without booting the firmware.
   *
   * The KC Monitor's own route here costs about 1.8 M cycles, because `LcdInit`
   * runs the HD44780 power-on ritual with four ~41 ms software delays in it —
   * `KCMonitor.test.ts` pays that price on purpose and this file should not.
   * Driving the controller directly reaches the same state: these are the same
   * commands the firmware sends, minus the waiting.
   */
  const paint = (session: Session, text: string): void => {
    const lcd = session.machine.lcd
    lcd.sendCommand(LCD_CMD_FUNCTION | LCD_CMD_FUNCTION_LCD_2LINE)
    lcd.sendCommand(LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
    lcd.sendCommand(LCD_CMD_CLEAR)
    for (const ch of text) lcd.writeByte(ch.charCodeAt(0))
  }

  it('reads the panel as two lines of text', () => {
    const { methods, session } = target()
    paint(session, 'KIM MONITOR v1.0')

    const result = methods['lcd.text']!({}) as { lines: string[] }
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toBe('KIM MONITOR v1.0')
    expect(result.lines[1]).toBe(' '.repeat(16))
  })

  it('hashes the pixels, so "did the panel change" is one number', () => {
    const { methods, session } = target()
    const a = (methods['lcd.hash']!({}) as { hash: string }).hash
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect((methods['lcd.hash']!({}) as { hash: string }).hash).toBe(a)

    paint(session, 'HELLO')
    expect((methods['lcd.hash']!({}) as { hash: string }).hash).not.toBe(a)
  })

  /**
   * The buffer's three values are the whole look of the panel: -1 is the gap
   * between characters, drawn as backlight, and 0 is an unlit dot, which on this
   * display is *visible*. A client that only received the lit pixels could not
   * draw the matrix.
   */
  it('returns the pixel buffer with its gaps intact', () => {
    const { methods, session } = target()
    paint(session, 'HELLO')

    const result = methods['lcd.pixels']!({}) as {
      width: number
      height: number
      cols: number
      rows: number
      data: string
    }

    expect([result.cols, result.rows]).toEqual([16, 2])
    expect(result.width).toBe(16 * 6 - 1)
    expect(result.height).toBe(2 * 9 - 1)

    const pixels = Buffer.from(result.data, 'base64')
    expect(pixels).toHaveLength(result.width * result.height)
    // -1 arrives as 255; the inter-character gap columns are made of them.
    expect([...pixels]).toContain(255)
    expect([...pixels]).toContain(1)
  })

  /**
   * There is no `notSupported` case here, and that is the point. The video card
   * 6502-EMULATOR has to ask about is optional; the LCD is on the Keypad Card,
   * which is soldered in, so the panel exists on every machine this emulator can
   * build — including one with no Serial Card at all.
   */
  it('answers on a keypad-only machine, where it is the only display there is', () => {
    const { methods } = target({ console: 'keypad', serial: false })
    expect((methods['lcd.text']!({}) as { lines: string[] }).lines).toHaveLength(2)
  })
})

describe('state', () => {
  it('saves the whole machine as JSON, with its size', () => {
    const { methods, session } = target()
    program(session, 0xa000, 0xa9, 0x42) // LDA #$42
    session.step('instruction')

    const saved = methods['state.save']!({}) as {
      state: { format: string; version: number }
      version: number
      bytes: number
    }

    expect(saved.state.format).toBe('6502-kim-snapshot')
    expect(saved.version).toBe(saved.state.version)
    expect(saved.bytes).toBe(JSON.stringify(saved.state).length)
  })

  it('round-trips a machine through save and load', async () => {
    const { methods, session } = target()
    program(session, 0xa000, 0xa9, 0x42)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    const at = session.machine.cpu.pc
    const a = session.machine.cpu.a

    session.step('instruction', 10)
    expect(session.machine.cpu.pc).not.toBe(at)

    const loaded = (await methods['state.load']!({ state: saved.state })) as {
      registers: { PC: number; A: number }
    }

    expect(loaded.registers.PC).toBe(at)
    expect(loaded.registers.A).toBe(a)
  })

  /**
   * The reason snapshots are worth having: this is the shape of an agent's inner
   * loop — restore, drive, assert — with no BIOS countdown in it.
   */
  it('restores repeatedly from one saved state', async () => {
    const { methods, session } = target()
    // INC $0300; JMP $A000 — a loop, so stepping on always changes something.
    program(session, 0xa000, 0xee, 0x00, 0x03, 0x4c, 0x00, 0xa0)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    expect(session.machine.peek(0x0300)).toBe(1)

    for (let i = 0; i < 3; i++) {
      session.step('instruction', 4)
      expect(session.machine.peek(0x0300)).toBeGreaterThan(1)

      await methods['state.load']!({ state: saved.state })
      expect(session.machine.peek(0x0300)).toBe(1)
    }
  })

  it('reads a snapshot from a file when the host has one', async () => {
    const { methods, session, target: t } = target()
    program(session, 0xa000, 0xa9, 0x42)
    session.step('instruction')

    const saved = methods['state.save']!({}) as { state: unknown }
    ;(t as { readTextFile?: (path: string) => string }).readTextFile = () =>
      JSON.stringify(saved.state)

    session.step('instruction', 5)
    const loaded = (await methods['state.load']!({ path: 'ready.state' })) as {
      registers: { A: number }
    }
    expect(loaded.registers.A).toBe(0x42)
  })

  it('reports a file that is not JSON as a load failure', async () => {
    const { methods, target: t } = target()
    ;(t as { readTextFile?: (path: string) => string }).readTextFile = () => 'not json'

    const error = await errorOf(() => methods['state.load']!({ path: 'broken.state' }))
    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/not valid JSON/)
  })

  it('needs either a state or a path', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['state.load']!({}))).code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('refuses a snapshot it cannot apply, and says how to recover', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['state.load']!({ state: { format: 'something-else' } })
    )

    expect(error.code).toBe(ErrorCode.LOAD_FAILED)
    expect(error.message).toMatch(/session\.reset to recover/)
  })
})

describe('parameters', () => {
  it('accepts an address as a number, $hex, 0xhex or a symbol', () => {
    const { methods, target: t } = target()
    t.symbols.add({ name: 'start', address: 0x0800 })

    for (const address of [0x0800, '$0800', '0x0800', '2048', 'start']) {
      expect(methods['bp.set']!({ address })).toMatchObject({ address: 0x0800 })
    }
    methods['bp.clear']!({})
  })

  it('rejects an address outside the address space', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['bp.set']!({ address: 0x10000 }))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })

  it('rejects malformed base64 rather than silently writing fewer bytes', async () => {
    const { methods } = target()
    const error = await errorOf(() =>
      methods['mem.write']!({ address: 0x0300, data: 'not valid base64!!' })
    )
    expect(error.code).toBe(ErrorCode.INVALID_PARAMS)
  })

  it('rejects params that are not an object', async () => {
    const { methods } = target()
    expect((await errorOf(() => methods['exec.step']!([1, 2, 3]))).code).toBe(
      ErrorCode.INVALID_PARAMS
    )
  })
})
