import { Session } from '../../debug/Session'
import { Empty } from '../../core/IO/Empty'
import { CardROM } from '../../core/CardROM'
import { compileExpression, evaluateExpression, ExpressionError } from '../../debug/Expression'
import type { StopReason } from '../../debug/Session'

/** A bare machine with no I/O cards, so only the code under test runs. */
function session(): Session {
  return new Session({
    io1: new Empty(),
    io2: new Empty(),
    io3: new Empty(),
    io4: new Empty(),
    io5: new Empty(),
    io6: new Empty(),
    io7: new Empty(),
    io8: new Empty()
  })
}

/** Assemble bytes into ROM at `at` and point the reset vector there. */
function program(s: Session, at: number, ...bytes: number[]): void {
  const rom = new Array(0x8000).fill(0xea)
  bytes.forEach((byte, i) => {
    rom[at - 0x8000 + i] = byte
  })
  s.machine.loadROM(rom)
  resetTo(s, at)
}

/**
 * Point RESET at `at` through the Keypad Card's ROM.
 *
 * Not through the BIOS: the card overlays $E000-$FFFF, so $FFFC of `BIOS.bin` is
 * not on this machine's bus and writing it would leave the CPU starting at $0000.
 */
function resetTo(s: Session, at: number): void {
  const card = new Array(CardROM.SIZE).fill(0xea)
  card[0xfffc - CardROM.START] = at & 0xff
  card[0xfffd - CardROM.START] = (at >> 8) & 0xff
  s.machine.loadCardROM(card)
  s.machine.reset(true)
}

/** Run until the session stops, or the budget runs out. */
async function runUntilStop(s: Session, budget = 2_000_000): Promise<StopReason | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const off = s.onStop((reason) => {
      if (settled) return
      settled = true
      off()
      resolve(reason)
    })
    s.run('turbo')
    setTimeout(() => {
      if (settled) return
      settled = true
      off()
      s.pause()
      resolve(undefined)
    }, 2000)
    void budget
  })
}

describe('Expression', () => {
  const context = {
    registers: { A: 0x42, X: 0x10, Y: 0, PC: 0xa000, SP: 0xfd, P: 0x20, ST: 0x20 },
    read: (address: number) => (address === 0x0400 ? 0x99 : address === 0x0401 ? 0x88 : 0)
  }

  it.each([
    ['A == $42', 1],
    ['A == 66', 1],
    ['A == 0x42', 1],
    ['A != $42', 0],
    ['X < 20', 1],
    ['PC >= $A000 && PC < $D000', 1],
    ['[$0400]', 0x99],
    ['[$0400] == $99', 1],
    ['{$0400}', 0x8899],
    ['A + X', 0x52],
    ['(A & $0F) == 2', 1],
    ['!0', 1],
    ['-1', -1],
    ['A == $42 || A == $00', 1]
  ])('evaluates %s', (source, expected) => {
    expect(evaluateExpression(source, context)).toBe(expected)
  })

  it('rejects nonsense rather than guessing', () => {
    expect(() => compileExpression('A ==')).toThrow(ExpressionError)
    expect(() => compileExpression('$')).toThrow(ExpressionError)
    expect(() => compileExpression('A B')).toThrow(ExpressionError)
    expect(() => compileExpression('#')).toThrow(ExpressionError)
  })

  it('reports an unknown name instead of treating it as zero', () => {
    expect(() => evaluateExpression('nope == 1', context)).toThrow(/unknown name/)
  })

  it('resolves symbols when a resolver is supplied', () => {
    expect(
      evaluateExpression('main', { ...context, symbol: (n) => (n === 'main' ? 0xc123 : undefined) })
    ).toBe(0xc123)
  })
})

describe('Breakpoints', () => {
  describe('execution', () => {
    it('stops before executing the instruction at the address', async () => {
      const s = session()
      // NOPs up to $A010, which is where we want to stop.
      program(s, 0xa000)
      s.addBreakpoint({ address: 0xa010 })

      const reason = await runUntilStop(s)

      expect(reason).toMatchObject({ kind: 'breakpoint', address: 0xa010 })
      expect(s.machine.cpu.pc).toBe(0xa010)
      expect(s.isRunning).toBe(false)
    })

    it('counts hits', async () => {
      const s = session()
      program(s, 0xa000)
      const bp = s.addBreakpoint({ address: 0xa004 })

      await runUntilStop(s)
      expect(bp.hits).toBe(1)
    })

    it('honours an ignore count', async () => {
      const s = session()
      // JMP back to itself via a loop: LDA #0; INC A; JMP $A002
      program(s, 0xa000, 0xa9, 0x00, 0x1a, 0x4c, 0x02, 0xa0)
      s.addBreakpoint({ address: 0xa002, ignoreCount: 3 })

      await runUntilStop(s)
      // Four passes over $A002; the first three are ignored and run INC A, and
      // the fourth breaks *before* executing it. So A has been incremented 3x.
      expect(s.machine.cpu.a).toBe(3)
    })

    it('removes a temporary breakpoint after it fires', async () => {
      const s = session()
      program(s, 0xa000)
      const bp = s.addBreakpoint({ address: 0xa008, temporary: true })

      await runUntilStop(s)
      expect(s.breakpoints.get(bp.id)).toBeUndefined()
    })

    it('ignores a disabled breakpoint', async () => {
      const s = session()
      program(s, 0xa000)
      const bp = s.addBreakpoint({ address: 0xa004 })
      s.setBreakpointEnabled(bp.id, false)

      const reason = await runUntilStop(s)
      expect(reason).toBeUndefined()
      expect(bp.hits).toBe(0)
    })

    it('breaks only when the condition holds', async () => {
      const s = session()
      // LDA #1 / LDA #2 / LDA #3, each followed by a NOP at $C00x.
      program(s, 0xa000, 0xa9, 0x01, 0xea, 0xa9, 0x02, 0xea, 0xa9, 0x03, 0xea)
      s.addBreakpoint({ address: 0xa002, condition: 'A == 3' })
      s.addBreakpoint({ address: 0xa005, condition: 'A == 3' })
      s.addBreakpoint({ address: 0xa008, condition: 'A == 3' })

      const reason = await runUntilStop(s)
      expect(reason).toMatchObject({ kind: 'breakpoint', address: 0xa008 })
      expect(s.machine.cpu.a).toBe(3)
    })
  })

  describe('watchpoints', () => {
    it('stops on a write to the watched address', async () => {
      const s = session()
      // LDA #$77; STA $0400
      program(s, 0xa000, 0xa9, 0x77, 0x8d, 0x00, 0x04)
      s.addBreakpoint({ kind: 'write', address: 0x0400 })

      const reason = await runUntilStop(s)

      expect(reason).toMatchObject({ kind: 'watchpoint', address: 0x0400, access: 'write' })
      expect(s.machine.read(0x0400)).toBe(0x77)
    })

    it('stops on a read of the watched address', async () => {
      const s = session()
      program(s, 0xa000, 0xad, 0x00, 0x04) // LDA $0400
      s.addBreakpoint({ kind: 'read', address: 0x0400 })

      const reason = await runUntilStop(s)
      expect(reason).toMatchObject({ kind: 'watchpoint', access: 'read' })
    })

    it('covers a range', async () => {
      const s = session()
      program(s, 0xa000, 0xa9, 0x01, 0x8d, 0x10, 0x04) // STA $0410
      s.addBreakpoint({ kind: 'write', address: 0x0400, end: 0x04ff })

      const reason = await runUntilStop(s)
      expect(reason).toMatchObject({ kind: 'watchpoint', address: 0x0410 })
    })

    it('a write watchpoint ignores reads of the same address', async () => {
      const s = session()
      program(s, 0xa000, 0xad, 0x00, 0x04) // LDA $0400, never writes
      s.addBreakpoint({ kind: 'write', address: 0x0400 })

      expect(await runUntilStop(s)).toBeUndefined()
    })
  })

  describe('arming', () => {
    it('reports nothing armed until a breakpoint is added', () => {
      const s = session()
      expect(s.breakpoints.armed).toBe(false)

      const bp = s.addBreakpoint({ address: 0xa000 })
      expect(s.breakpoints.armed).toBe(true)

      s.removeBreakpoint(bp.id)
      expect(s.breakpoints.armed).toBe(false)
    })

    // The bus taps are the only per-access cost, so they must not be installed
    // unless a watchpoint actually needs them.
    it('installs bus taps only while a watchpoint exists', () => {
      const s = session()
      expect(s.machine.onWrite).toBeUndefined()

      const exec = s.addBreakpoint({ address: 0xa000 })
      expect(s.machine.onWrite).toBeUndefined()

      const watch = s.addBreakpoint({ kind: 'write', address: 0x0400 })
      expect(s.machine.onWrite).toBeDefined()

      s.removeBreakpoint(watch.id)
      expect(s.machine.onWrite).toBeUndefined()
      s.removeBreakpoint(exec.id)
    })

    it('rejects a malformed condition at the point it is set', () => {
      const s = session()
      expect(() => s.addBreakpoint({ address: 0xa000, condition: 'A ==' })).toThrow(
        /condition/
      )
    })
  })
})

describe('Stepping over and out', () => {
  it('steps over a JSR in one step', () => {
    const s = session()
    // $A000 JSR $A010 ; $A003 LDA #$42
    // $A010 NOP ; $A011 RTS
    program(s, 0xa000, 0x20, 0x10, 0xa0, 0xa9, 0x42)
    s.machine.ram.write(0, 0) // no-op, keeps ram referenced
    const rom = new Array(0x8000).fill(0xea)
    rom[0xa000 - 0x8000] = 0x20
    rom[0xa001 - 0x8000] = 0x10
    rom[0xa002 - 0x8000] = 0xa0
    rom[0xa003 - 0x8000] = 0xa9
    rom[0xa004 - 0x8000] = 0x42
    rom[0xa010 - 0x8000] = 0xea
    rom[0xa011 - 0x8000] = 0x60
    s.machine.loadROM(rom)
    resetTo(s, 0xa000)

    s.step('over')
    expect(s.machine.cpu.pc).toBe(0xa003)
  })

  it('steps over a non-call as an ordinary single step', () => {
    const s = session()
    program(s, 0xa000, 0xa9, 0x42) // LDA #$42
    s.step('over')
    expect(s.machine.cpu.pc).toBe(0xa002)
    expect(s.machine.cpu.a).toBe(0x42)
  })

  it('runs out of a subroutine to the instruction after the call', () => {
    const s = session()
    const rom = new Array(0x8000).fill(0xea)
    // $A000 JSR $A010 ; $A003 LDA #$42
    rom[0xa000 - 0x8000] = 0x20
    rom[0xa001 - 0x8000] = 0x10
    rom[0xa002 - 0x8000] = 0xa0
    rom[0xa003 - 0x8000] = 0xa9
    rom[0xa004 - 0x8000] = 0x42
    // $A010 NOP ; NOP ; RTS
    rom[0xa012 - 0x8000] = 0x60
    s.machine.loadROM(rom)
    resetTo(s, 0xa000)

    s.step('instruction') // into the subroutine
    expect(s.machine.cpu.pc).toBe(0xa010)

    s.step('out')
    expect(s.machine.cpu.pc).toBe(0xa003)
  })

  it('gives up rather than hanging when the call depth never unwinds', () => {
    const s = session()
    // JSR to a routine that jumps to itself and never returns.
    const rom = new Array(0x8000).fill(0xea)
    rom[0xa000 - 0x8000] = 0x20
    rom[0xa001 - 0x8000] = 0x10
    rom[0xa002 - 0x8000] = 0xa0
    rom[0xa010 - 0x8000] = 0x4c // JMP $A010
    rom[0xa011 - 0x8000] = 0x10
    rom[0xa012 - 0x8000] = 0xa0
    s.machine.loadROM(rom)
    resetTo(s, 0xa000)

    const reason = s.step('over')
    expect(reason).toMatchObject({ kind: 'trap' })
  }, 30_000)
})
