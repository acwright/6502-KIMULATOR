/**
 * The phase 3 exit criteria, run against the real firmware over the real method
 * table.
 *
 * `KCMonitor.test.ts` proves the machine; this proves the protocol on top of it.
 * Everything here goes through `createMethods` rather than through `Machine`
 * directly, because the criterion is not "the monitor moves" — phase 2 settled
 * that — it is "a scripted client can move it and see that it moved", which is
 * the whole point of `keypad.press` and `lcd.text` existing.
 *
 * It is slow for the same reason phase 2's is: `LcdInit` runs the HD44780
 * power-on ritual with four ~41 ms software delays in it, so reaching the splash
 * costs about 1.8 million clock cycles. That cost is also the argument for
 * `state.save`, which is exercised at the end.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Session } from '../../debug/Session'
import { Empty } from '../../core/IO/Empty'
import { SymbolTable } from '../../debug/symbols/Symbols'
import { createMethods } from '../../debug/server/Methods'
import type { MethodTable } from '../../debug/server/Methods'
import type { SlotConfig } from '../../core/Machine'
import type { DebugTarget } from '../../debug/server/DebugTarget'

const ROOT = join(__dirname, '../../..')
const BIOS = readFileSync(join(ROOT, 'assets/roms/BIOS.bin'))
const KC_MONITOR = readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin'))

/** Where the monitor starts, and where user programs live — 6502.inc. */
const PROGRAM_START = 0x0800

interface Fixture {
  methods: MethodTable
  session: Session
  /** Console output the machine has transmitted, as text. */
  output: () => string
}

function fixture(slots: SlotConfig = {}): Fixture {
  const session = new Session(slots)
  session.machine.loadROM(BIOS)
  session.machine.loadCardROM(KC_MONITOR)
  session.machine.resetCPU()

  let stream = ''
  session.machine.transmit = (byte) => {
    stream += String.fromCharCode(byte)
  }

  const target: DebugTarget = {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '9.9.9',
    consoleMode: () => (session.machine.acia() ? 'serial' : 'keypad')
  }

  return { methods: createMethods(target), session, output: () => stream }
}

/** The panel's top line, through the protocol. */
const line = (f: Fixture, row = 0): string =>
  (f.methods['lcd.text']!({}) as { lines: string[] }).lines[row]!

/** Run in bounded steps until the panel says what we are waiting for. */
function runUntil(f: Fixture, done: () => boolean, budget = 4_000_000): boolean {
  for (let spent = 0; spent < budget; spent += 25_000) {
    f.methods['exec.runCycles']!({ cycles: 25_000 })
    if (done()) return true
  }
  return false
}

/** Press a key over the protocol and let the monitor finish repainting. */
async function press(f: Fixture, key: string): Promise<void> {
  await f.methods['keypad.press']!({ key })
  f.methods['exec.runCycles']!({ cycles: 200_000 })
}

/** A machine sitting at the monitor's first painted screen. */
async function atMonitor(slots: SlotConfig = {}): Promise<Fixture> {
  const f = fixture(slots)
  expect(runUntil(f, () => line(f).startsWith('KIM MONITOR'))).toBe(true)
  // The splash gate: ESC, and nothing else, starts the monitor.
  await press(f, 'ESC')
  expect(runUntil(f, () => line(f).includes('$'), 500_000)).toBe(true)
  return f
}

describe('the KC Monitor over the debug protocol', () => {
  it('boots to the splash and reports it as text', async () => {
    const f = fixture()
    expect(runUntil(f, () => line(f).startsWith('KIM MONITOR'))).toBe(true)

    expect(f.methods['lcd.text']!({})).toEqual({
      lines: ['KIM MONITOR v1.0', '--ESC TO START--']
    })
  })

  it('reports the machine it is serving', async () => {
    const f = fixture()
    expect(f.methods['session.info']!({})).toMatchObject({
      console: 'serial',
      serialCard: true,
      frequency: 1_000_000
    })
  })

  /**
   * The exit criterion, stated plainly: `keypad.press` moves the monitor over the
   * protocol.
   *
   * KIM-1 style, a hex key shifts a nibble in from the right, so keying four of
   * them walks the address across one digit at a time — and every step is checked
   * through `lcd.text`, because a client that could press keys but not see the
   * result would not be able to drive anything.
   */
  it('keys an address, a nibble at a time, and the panel follows', async () => {
    const f = await atMonitor()
    expect(line(f)).toBe('---$0800: $00---')

    await press(f, '1')
    expect(line(f)).toBe('---$8001: $00---')

    await press(f, '2')
    expect(line(f)).toBe('---$0012: $00---')

    await press(f, 'A')
    expect(line(f)).toBe('---$012A: $00---')

    await press(f, 'F')
    expect(line(f)).toBe('---$12AF: $00---')
  })

  /**
   * The trap the encoder sets: `0` is code $0A, not $00. A `keypad.press` that
   * derived the code from the digit would key `◄` here and the address would go
   * backwards instead of taking a zero.
   */
  it('keys a 0 as a 0, not as the left arrow', async () => {
    const f = await atMonitor()

    await press(f, '8')
    await press(f, '0')
    await press(f, '0')
    expect(line(f)).toBe('---$0800: $00---')
  })

  /** A whole sequence in one call, paced so the latch is read between presses. */
  it('keys a sequence in one call', async () => {
    const f = await atMonitor()

    f.session.run('turbo')
    await f.methods['keypad.press']!({ key: ['1', '2', 'A', 'F'], kps: 200 })
    f.session.pause()
    f.methods['exec.runCycles']!({ cycles: 400_000 })

    expect(line(f)).toBe('---$12AF: $00---')
  })

  it('deposits a byte from the pad and the machine has it in RAM', async () => {
    const f = await atMonitor()

    // INS enters edit mode; two hex keys make the byte; ► commits and advances.
    await press(f, 'INS')
    await press(f, 'A')
    await press(f, '9')
    await press(f, 'RIGHT')

    const read = f.methods['mem.read']!({ address: PROGRAM_START, length: 1 }) as { data: string }
    expect([...Buffer.from(read.data, 'base64')]).toEqual([0xa9])
  })

  /** What the pad put there, disassembled — the two halves of a session meeting. */
  it('disassembles what was just keyed in', async () => {
    const f = await atMonitor()
    f.methods['mem.write']!({ address: PROGRAM_START, data: [0xa9, 0x42] })

    const result = f.methods['disasm.at']!({ address: PROGRAM_START, count: 1 }) as {
      instructions: { text: string }[]
    }
    expect(result.instructions[0]!.text).toContain('LDA #$42')
  })

  it('answers the serial terminal as well as the glass', async () => {
    const f = fixture()
    runUntil(f, () => line(f).startsWith('KIM MONITOR'))
    f.methods['exec.runCycles']!({ cycles: 500_000 })

    expect(f.output()).toContain('KIM MONITOR v1.0')
  })

  /**
   * The keypad-only machine, over the protocol. io5 is vacant, so `serial.*`
   * has nothing to serve — but the pad and the panel are on the Keypad Card and
   * are exactly as available as they were, which is what makes this a supported
   * configuration rather than a degraded one.
   */
  it('drives a machine with no Serial Card at all', async () => {
    const f = await atMonitor({ io5: new Empty() })

    expect(f.methods['session.info']!({})).toMatchObject({
      console: 'keypad',
      serialCard: false
    })
    expect(() => f.methods['serial.write']!({ data: 'x' })).toThrow(/no serial console/)

    await press(f, '1')
    expect(line(f)).toBe('---$8001: $00---')
  })

  /**
   * The argument for snapshots on this machine, demonstrated rather than
   * asserted: restore lands back at the monitor without paying the LCD's
   * ~1.8 M-cycle power-on ritual a second time.
   */
  it('saves at the monitor and restores there, repeatedly', async () => {
    const f = await atMonitor()
    const saved = f.methods['state.save']!({}) as { state: unknown }
    const at = line(f)

    for (let i = 0; i < 2; i++) {
      await press(f, '1')
      await press(f, '2')
      expect(line(f)).not.toBe(at)

      const before = f.session.cycles
      await f.methods['state.load']!({ state: saved.state })
      expect(line(f)).toBe(at)
      // The whole point: getting back cost nothing, and the clock still moved
      // forward, because elapsed emulated time is not rewound by a restore.
      expect(f.session.cycles).toBe(before)
    }
  })

  /** A breakpoint in the Keypad Card's ROM, by address, hit by the running firmware. */
  it('breaks inside the Keypad Card ROM', async () => {
    const f = await atMonitor()

    // The RESET vector's target — the monitor's own entry point, which a warm
    // reset goes through again.
    const vector = f.methods['mem.read']!({ address: 0xfffc, length: 2 }) as { data: string }
    const [low, high] = [...Buffer.from(vector.data, 'base64')]
    const entry = (high! << 8) | low!
    expect(entry).toBeGreaterThanOrEqual(0xe000)

    f.methods['bp.set']!({ address: entry })
    f.methods['session.reset']!({ cold: false })

    const result = (await f.methods['wait.for']!({
      stopped: true,
      run: 'turbo',
      timeoutMs: 5000
    })) as { reason: string; stop: { kind: string; address: number } }

    expect(result.reason).toBe('stopped')
    expect(result.stop).toMatchObject({ kind: 'breakpoint', address: entry })
  })
})
