import { createServer } from 'node:http'
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../../../debug/Session'
import { CardROM } from '../../../core/CardROM'
import {
  LCD_CMD_DISPLAY,
  LCD_CMD_DISPLAY_ON
} from '../../../core/IO/Attachments/LCDAttachment'
import { DebugServer } from '../../../debug/server/DebugServer'
import { createMethods } from '../../../debug/server/Methods'
import type { DebugTarget } from '../../../debug/server/DebugTarget'
import { SymbolTable } from '../../../debug/symbols/Symbols'
import { dispatch } from '../../../cli/dbg/Commands'
import { ExitCode } from '../../../cli/dbg/ExitCode'

/**
 * Integration tests: a real DebugServer on a real loopback port, driven
 * through the same `dispatch()` the CLI's own process calls.
 *
 * `--port` is passed on every call rather than going through the lock file, so
 * these tests are about Commands.ts's own parsing, RPC calls and exit codes —
 * not a second copy of LockFile's tests.
 */

/** A machine in its standard shape: the Serial Card in io5, the bay empty. */
function bareSession(): Session {
  return new Session()
}

/**
 * Assemble bytes into the BIOS at `at` and point the reset vector there.
 *
 * `$A000` rather than 6502-EMULATOR's `$C000`: on a KIM that address is the
 * PIA, mirrored every four bytes, so a program assembled there would be writing
 * to a 65C21. And the vector goes into the Keypad Card's ROM, because the card
 * overlays `$E000-$FFFF` and `$FFFC` of `BIOS.bin` is not on this bus.
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

let server: DebugServer
let session: Session
let port: number
let token: string

beforeEach(async () => {
  session = bareSession()
  const target: DebugTarget = {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '9.9.9',
    consoleMode: () => 'serial',
    // sym.load and media.load* resolve a path against the host's own
    // filesystem — see Commands.ts's symLoad, which sends an absolute path
    // rather than reading the file itself.
    readTextFile: (path) => readFileSync(path, 'utf8'),
    readBinaryFile: (path) => new Uint8Array(readFileSync(path)),
    setFlowControl: (on) => {
      session.machine.flowControl = on
    }
  }
  server = new DebugServer({
    hostName: target.hostName,
    version: target.version,
    hostKind: 'headless',
    methods: createMethods(target),
    onEvent: () => () => {},
    lockFile: false
  })
  const listening = await server.listen()
  port = listening.port
  token = listening.token
})

afterEach(async () => {
  await server.close()
})

/**
 * Connection flags go *after* the command's own arguments, not before.
 *
 * Several commands (mem, disasm, break, sym, load, lcd, state) take a
 * sub-subcommand as their first token — `mem write ...` — and read it
 * positionally rather than through parseArgs, so anything placed ahead of it
 * would be mistaken for that token. This mirrors exactly how `attach.ts`
 * appends the connection it resolved once at startup to each typed line.
 */
const connectionArgs = (): string[] => ['--port', String(port), '--token', token]

/** Run a command, capturing what it wrote to stdout and its exit code. */
async function run(name: string, args: string[] = []): Promise<{ exitCode: number; out: string }> {
  const chunks: string[] = []
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const exitCode = await dispatch(name, [...args, ...connectionArgs()])
    return { exitCode, out: chunks.join('') }
  } finally {
    spy.mockRestore()
  }
}

async function runErr(name: string, args: string[] = []): Promise<{ exitCode: number; err: string }> {
  const chunks: string[] = []
  const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  try {
    const exitCode = await dispatch(name, [...args, ...connectionArgs()])
    return { exitCode, err: chunks.join('') }
  } finally {
    spy.mockRestore()
  }
}

describe('session commands', () => {
  it('info reports the host, the console and whether the Serial Card is in', async () => {
    const { exitCode, out } = await run('info')
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('test')
    expect(out).toContain('serial console')
    expect(out).toContain('Serial Card fitted')
  })

  it('config --flow-control turns flow control on and off, and info says when it is on', async () => {
    expect((await run('info')).out).not.toContain('flow control')

    const on = await run('config', ['--flow-control', 'on', '--json'])
    expect(on.exitCode).toBe(ExitCode.OK)
    expect(JSON.parse(on.out)).toMatchObject({ flowControl: true })
    expect(session.machine.flowControl).toBe(true)
    expect((await run('info')).out).toMatch(/Serial Card fitted, flow control, /)

    await run('config', ['--flow-control', 'off'])
    expect(session.machine.flowControl).toBe(false)
  })

  it('config --flow-control takes only on or off', async () => {
    const { exitCode, err } = await runErr('config', ['--flow-control', 'yes'])
    expect(exitCode).not.toBe(ExitCode.OK)
    expect(err).toContain('--flow-control: expected "on" or "off"')
  })

  it('info --json prints the raw result', async () => {
    const { out } = await run('info', ['--json'])
    expect(JSON.parse(out)).toMatchObject({ host: 'test', protocol: 1 })
  })

  it('reset zeroes the registers', async () => {
    session.machine.cpu.a = 0x42
    await run('reset')
    expect(session.machine.cpu.a).toBe(0)
  })

  /**
   * The flag exists so a script ported from 6502-EMULATOR is told the clock did
   * not change, rather than being quietly ignored — PHI2 on this board is fixed
   * at 1 MHz and the 2 MHz jumper is the ACE's.
   */
  it('config refuses a frequency this machine cannot have, and says why', async () => {
    const { exitCode, err } = await runErr('config', ['--frequency', '2'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/fixed at 1000000/)
    expect(session.machine.frequency).toBe(1_000_000)
  })
})

describe('reg commands', () => {
  it('regs with no arguments reads', async () => {
    session.machine.cpu.a = 0x42
    const { out } = await run('regs')
    expect(out).toContain('A=$42')
  })

  it('regs --set writes registers, accepting hex or decimal', async () => {
    await run('regs', ['--set', 'A=0x42', '--set', 'X=16'])
    expect(session.machine.cpu.a).toBe(0x42)
    expect(session.machine.cpu.x).toBe(16)
  })

  it('reg is an alias for regs', async () => {
    session.machine.cpu.x = 0x10
    const { out } = await run('reg')
    expect(out).toContain('X=$10')
  })
})

describe('mem commands', () => {
  it('writes and reads back a hex byte string', async () => {
    await run('mem', ['write', '0x0300', 'DEADBEEF'])
    const { out } = await run('mem', ['0x0300', '4'])
    expect(out).toContain('DE AD BE EF')
  })

  it('fills a range', async () => {
    await run('mem', ['fill', '0x0400', '4', '0xAA'])
    const { out } = await run('mem', ['0x0400', '4'])
    expect(out).toContain('AA AA AA AA')
  })

  it('searches and reports matches', async () => {
    await run('mem', ['write', '0x1234', 'CAFE'])
    const { out } = await run('mem', ['search', 'CAFE', '--space', 'ram'])
    expect(out).toContain('$1234')
  })

  /**
   * Every space but `cpu` takes an offset into an image, which the protocol
   * wants as a number — so the hex a 6502 programmer writes is converted before
   * it goes on the wire rather than coming back as "expected a number".
   */
  it('reads the Keypad Card ROM at a hex offset', async () => {
    program(session, 0xa000)
    const { exitCode, out } = await run('mem', ['0x1FFC', '2', '--space', 'card'])
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('00 A0') // the reset vector program() just wrote
  })

  it('reports a space it does not have as an error, exit 1', async () => {
    const { exitCode, err } = await runErr('mem', ['0', '--space', 'vram'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/vram/)
  })
})

describe('break commands', () => {
  it('sets, lists and clears', async () => {
    const set = await run('break', ['0xA000'])
    expect(set.out).toContain('$A000')

    const list = await run('break', ['list'])
    expect(list.out).toContain('#1')

    const clear = await run('break', ['clear'])
    expect(clear.exitCode).toBe(ExitCode.OK)

    const empty = await run('break', ['list'])
    expect(empty.out).toContain('no breakpoints')
  })

  it('sets a condition and a watchpoint kind', async () => {
    const { out } = await run('break', ['0x0400', '--watch', 'write', '--condition', 'A == 3'])
    expect(out).toContain('write')
    expect(out).toContain('if A == 3')
  })
})

describe('exec commands', () => {
  it('step advances one instruction and prints the new state', async () => {
    program(session, 0xa000, 0xa9, 0x42) // LDA #$42
    const { exitCode, out } = await run('step')
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('A=$42')
    expect(session.machine.cpu.pc).toBe(0xa002)
  })

  // The exit code an agent branches on to tell "ran to completion" apart from
  // "something it was watching for actually happened".
  it('runto exits 4 when the address is a breakpoint that fires', async () => {
    program(session, 0xa000)
    const { exitCode, out } = await run('runto', ['0xA010', '--timeout', '2s'])
    expect(exitCode).toBe(ExitCode.HIT)
    expect(out).toContain('breakpoint')
    expect(session.machine.cpu.pc).toBe(0xa010)
  })

  it('runto exits 0 when it gives up without hitting anything', async () => {
    program(session, 0xa000, 0x4c, 0x00, 0xa0) // JMP $A000, forever
    const { exitCode } = await run('runto', ['0xB000', '--timeout', '100ms'])
    expect(exitCode).toBe(ExitCode.OK)
  })

  it('runcycles reports the cycle-budget stop', async () => {
    program(session, 0xa000)
    const { exitCode, out } = await run('runcycles', ['1000'])
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('1000 cycles')
    expect(session.cycles).toBe(1000)
  })
})

describe('key commands', () => {
  /**
   * The pad is the whole of this machine's input, and the encoder reports one
   * thing: a press. So there is no --down/--up here, and nothing to release.
   */
  it('presses a key by name and reports what it pressed', async () => {
    const { exitCode, out } = await run('key', ['INS'])
    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('pressed INS')
  })

  /**
   * A bare number is a *name*, not an encoder code. The code is not the key's
   * value — `0` reports $0A — so reading `key 0` as a code would press ◄ when
   * every finger in the world meant the zero key.
   */
  it('reads a bare number as the key with that legend, not as a code', async () => {
    const { out } = await run('key', ['0'])
    expect(out).toContain('pressed 0')

    const byCode = await run('key', ['$00'])
    expect(byCode.out).toContain('pressed ◄')
  })

  it('refuses a key this pad does not have, and lists the ones it does', async () => {
    const { exitCode, err } = await runErr('key', ['F13'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/no key "F13"/)
    expect(err).toMatch(/PGUP/)
  })

  it('--list prints the pad in its own layout, with every encoder code', async () => {
    const { out } = await run('key', ['--list'])
    expect(out).toMatch(/ESC\s+\$10/)
    expect(out).toMatch(/0\s+\$0A/)
    expect(out.trimEnd().split('\n')).toHaveLength(6)
  })
})

describe('lcd commands', () => {
  it('prints the panel boxed, so trailing blanks are visible', async () => {
    const { exitCode, out } = await run('lcd')
    expect(exitCode).toBe(ExitCode.OK)
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(4) // rule, two rows, rule
    expect(lines[0]).toMatch(/^\+-+\+$/)
    expect(lines[1]).toHaveLength(18)
  })

  it('hash is a digest of the pixels, and changes when the panel does', async () => {
    const before = await run('lcd', ['hash'])
    expect(before.out.trim()).toMatch(/^[0-9a-f]{8}$/)

    // The panel comes up dark, so lighting it is part of changing it: an "A"
    // written into DDRAM with the display off lights no dots at all.
    session.machine.lcd.sendCommand(LCD_CMD_DISPLAY | LCD_CMD_DISPLAY_ON)
    session.machine.lcd.writeByte(0x41)
    const after = await run('lcd', ['hash'])
    expect(after.out).not.toBe(before.out)
  })

  it('pixels draws the dot matrix, gaps and all', async () => {
    const { out } = await run('lcd', ['pixels'])
    // 16 characters of 5 dots with a gap between them, and 2 rows of 8.
    expect(out.trimEnd().split('\n')).toHaveLength(2 * 9 - 1)
    expect(out).toMatch(/^[.# \n]+$/)
  })
})

describe('media commands', () => {
  /**
   * `load card-rom` is where 6502-EMULATOR has `load cart`, and the rename is
   * the point: this replaces the machine's own firmware rather than slotting in
   * a cartridge. There is no `unload`, because there is no state in which the
   * card is absent.
   */
  it('loads a Keypad Card ROM and resets onto its vectors', async () => {
    const path = join(tmpdir(), `kim-card-${process.pid}.bin`)
    const image = new Uint8Array(CardROM.SIZE).fill(0xea)
    image[0xfffc - CardROM.START] = 0x34
    image[0xfffd - CardROM.START] = 0x12
    writeFileSync(path, image)

    try {
      const { exitCode } = await run('load', ['card-rom', path])
      expect(exitCode).toBe(ExitCode.OK)
      expect(session.machine.cpu.pc).toBe(0x1234)
    } finally {
      unlinkSync(path)
    }
  })

  it('refuses a card ROM that is not the 8 KB an AT28C64 holds', async () => {
    const path = join(tmpdir(), `kim-card-short-${process.pid}.bin`)
    writeFileSync(path, new Uint8Array(1024))

    try {
      const { exitCode, err } = await runErr('load', ['card-rom', path])
      expect(exitCode).toBe(ExitCode.ERROR)
      expect(err).toMatch(/exactly 8192 bytes/)
    } finally {
      unlinkSync(path)
    }
  })

  it('rejects a sub-command it does not have, and names the ones it does', async () => {
    const { exitCode, err } = await runErr('load', ['cart', 'game.crt'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/expected rom, card-rom or bin/)
  })
})

describe('sym commands', () => {
  it('loads from inline text is not available on the CLI — a real file only', async () => {
    // sym load always resolves a path, matching the wire contract used by the
    // running emulator's own filesystem — see symLoad in Commands.ts.
    const { exitCode, err } = await runErr('sym', ['load', '/does/not/exist.lbl'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/cannot read/)
  })

  it('resolves and looks up once loaded', async () => {
    const path = join(tmpdir(), `sym-${Date.now()}.lbl`)
    writeFileSync(path, 'al C:A000 .main\n')

    try {
      await run('sym', ['load', path])
      const resolved = await run('sym', ['resolve', 'main'])
      expect(resolved.out).toContain('40960')

      const looked = await run('sym', ['lookup', '0xA000'])
      expect(looked.out).toContain('main')
    } finally {
      unlinkSync(path)
    }
  })
})

describe('state commands', () => {
  /**
   * The snapshot file is written and read by the CLI, not by the emulator.
   *
   * Deliberate: the emulator may be a packaged app in another directory or on
   * another machine over `--host`, and the path a person typed is relative to
   * *this* process's cwd. So these tests exercise a real file on disk.
   */
  const statePath = join(tmpdir(), `6502-kim-state-${process.pid}.state`)

  afterEach(() => {
    try {
      unlinkSync(statePath)
    } catch {
      // The test may not have got as far as writing it.
    }
  })

  it('save writes a snapshot to the given path and reports its size', async () => {
    program(session, 0xa000, 0xa9, 0x42)
    session.step('instruction')

    const { exitCode, out } = await run('state', ['save', statePath])

    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toMatch(new RegExp(`wrote \\d+ bytes to ${statePath.replace(/\\/g, '\\\\')}`))
    // The two emulators refuse each other's files, which starts here.
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      format: '6502-kim-snapshot'
    })
  })

  it('save --json prints the snapshot instead of writing a file', async () => {
    const { out } = await run('state', ['save', '--json'])
    expect(JSON.parse(out)).toMatchObject({ state: { format: '6502-kim-snapshot' } })
  })

  it('load puts the machine back where it was', async () => {
    program(session, 0xa000, 0xa9, 0x42)
    session.step('instruction')
    await run('state', ['save', statePath])

    const at = session.machine.cpu.pc
    session.step('instruction', 10)
    expect(session.machine.cpu.pc).not.toBe(at)

    const { exitCode, out } = await run('state', ['load', statePath])

    expect(exitCode).toBe(ExitCode.OK)
    expect(out).toContain('restored')
    expect(session.machine.cpu.pc).toBe(at)
    expect(session.machine.cpu.a).toBe(0x42)
  })

  it('load reports a missing file as a usage error, not an RPC one', async () => {
    const { exitCode, err } = await runErr('state', ['load', join(tmpdir(), 'nope.state')])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/cannot read/)
  })

  it('load reports a ROM mismatch rather than pretending it went fine', async () => {
    await run('state', ['save', statePath])

    const snapshot = JSON.parse(readFileSync(statePath, 'utf8')) as { rom: { crc32: string } }
    snapshot.rom.crc32 = '00000000'
    writeFileSync(statePath, JSON.stringify(snapshot))

    const plain = await runErr('state', ['load', statePath])
    expect(plain.exitCode).toBe(ExitCode.ERROR)
    expect(plain.err).toMatch(/different BIOS ROM/)

    const forced = await run('state', ['load', statePath, '--force'])
    expect(forced.exitCode).toBe(ExitCode.OK)
    expect(forced.out).toMatch(/do not match/)
  })

  it('rejects a sub-command it does not have', async () => {
    const { exitCode, err } = await runErr('state', ['restore'])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/expected save or load/)
  })
})

describe('connection errors', () => {
  it('reports exit code 3 when nothing is listening', async () => {
    // A port just released is reliably unbound for the moment this takes.
    const probe = createServer()
    const freedPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port))
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    const chunks: string[] = []
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    const exitCode = await dispatch('info', ['--port', String(freedPort)])
    spy.mockRestore()

    expect(exitCode).toBe(ExitCode.NOT_RUNNING)
    expect(chunks.join('')).toMatch(/could not reach/)
  })

  it('reports a usage error as exit 1 without contacting the server', async () => {
    const { exitCode, err } = await runErr('break', [])
    expect(exitCode).toBe(ExitCode.ERROR)
    expect(err).toMatch(/expected an address/)
  })

  it('reports an unknown command as exit 1', async () => {
    const chunks: string[] = []
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    const exitCode = await dispatch('nonsense', [])
    spy.mockRestore()

    expect(exitCode).toBe(ExitCode.ERROR)
    expect(chunks.join('')).toMatch(/unknown command/)
  })

  /**
   * The families that went with the hardware. A script ported from
   * 6502-EMULATOR should be told there is no video card and no matrix keyboard
   * on this machine, not left wondering why nothing happened.
   */
  it('has no screen or input command, because there is no such hardware', async () => {
    const chunks: string[] = []
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c))
      return true
    })
    expect(await dispatch('screen', [])).toBe(ExitCode.ERROR)
    expect(await dispatch('input', ['key', 'A'])).toBe(ExitCode.ERROR)
    spy.mockRestore()
    expect(chunks.join('')).toMatch(/Commands: .*key.*lcd/)
  })
})
