import {
  formatBreakpoint,
  formatBreakpoints,
  formatDisasm,
  formatFlags,
  formatKeypad,
  formatLCD,
  formatLCDPixels,
  formatRegisters,
  formatStop,
  formatSymbols,
  hexByte,
  hexWord,
  hexDump
} from '../../../cli/dbg/format'
import { KEYPAD } from '../../../core/KeypadMap'

describe('hexByte / hexWord', () => {
  it('pads and uppercases', () => {
    expect(hexByte(0x0a)).toBe('$0A')
    expect(hexWord(0xc0)).toBe('$00C0')
  })
})

describe('formatFlags', () => {
  // The classic monitor rendering: uppercase where set, lowercase where clear,
  // in the wire order NV-BDIZC.
  it('uppercases set flags and lowercases clear ones, in order', () => {
    expect(
      formatFlags({ N: true, V: false, B: false, D: false, I: true, Z: false, C: true })
    ).toBe('NvbdIzC')
  })
})

describe('formatRegisters', () => {
  it('renders every register and the flag string', () => {
    const text = formatRegisters({
      A: 0x42,
      X: 0x10,
      Y: 0x00,
      PC: 0xa000,
      SP: 0xfd,
      P: 0x20,
      flags: { N: false, V: false, B: false, D: false, I: false, Z: false, C: false }
    })
    expect(text).toContain('A=$42')
    expect(text).toContain('PC=$A000')
    expect(text).toContain('[nvbdizc]')
  })
})

describe('formatBreakpoint(s)', () => {
  const bp = {
    id: 1,
    kind: 'exec',
    address: 0xa000,
    end: 0xa000,
    ignoreCount: 0,
    temporary: false,
    enabled: true,
    hits: 3
  }

  it('shows a single address, hits and id', () => {
    const text = formatBreakpoint(bp)
    expect(text).toContain('#1')
    expect(text).toContain('$A000')
    expect(text).toContain('hits=3')
    expect(text).not.toContain('-')
  })

  it('shows a range when end differs from address', () => {
    expect(formatBreakpoint({ ...bp, kind: 'write', end: 0xa0ff })).toContain('$A000-$A0FF')
  })

  it('mentions a condition, disabled state and temporary flag', () => {
    const text = formatBreakpoint({ ...bp, condition: 'A == 3', enabled: false, temporary: true })
    expect(text).toContain('if A == 3')
    expect(text).toContain('disabled')
    expect(text).toContain('temporary')
  })

  it('prints something readable for an empty list', () => {
    expect(formatBreakpoints([])).toBe('(no breakpoints)')
  })
})

describe('formatStop', () => {
  it.each([
    [{ kind: 'breakpoint', id: 2, address: 0xa010 }, /breakpoint #2 at \$A010/],
    [{ kind: 'watchpoint', id: 3, address: 0x0400, access: 'write' }, /watchpoint #3 \(write\)/],
    [{ kind: 'cycle-budget', cycles: 1000 }, /ran 1000 cycles/],
    [{ kind: 'trap', detail: 'stack desynchronised' }, /trap: stack desynchronised/],
    [{ kind: 'paused' }, /paused/]
  ])('renders %o', (stop, pattern) => {
    expect(formatStop(stop)).toMatch(pattern)
  })
})

describe('hexDump', () => {
  it('lays out 16 bytes per line with a matching ASCII gutter', () => {
    const bytes = Uint8Array.from([...'Hello, World!!!!'].map((c) => c.charCodeAt(0)))
    const text = hexDump(0x0300, bytes)
    expect(text).toMatch(/^0300\s+48 65 6C/)
    expect(text).toContain('Hello, World!!!!')
  })

  it('handles a non-printable byte with a dot', () => {
    expect(hexDump(0, Uint8Array.of(0x00, 0x41))).toContain('.A')
  })

  it('wraps onto a new line past 16 bytes', () => {
    const text = hexDump(0, new Uint8Array(20))
    expect(text.split('\n')).toHaveLength(2)
  })
})

describe('formatDisasm', () => {
  it('marks the instruction at the PC', () => {
    const instructions = [
      { address: 0xa000, bytes: [0xea], text: 'A000  EA        NOP' },
      { address: 0xa001, bytes: [0xea], text: 'A001  EA        NOP' }
    ]
    const text = formatDisasm(instructions, 0xa001)
    const lines = text.split('\n')
    expect(lines[0]!.startsWith(' ')).toBe(true)
    expect(lines[1]!.startsWith('>')).toBe(true)
  })
})

describe('formatSymbols', () => {
  it('lists name, address and source', () => {
    const text = formatSymbols([{ name: 'main', address: 0xa000, source: 'KC Monitor.lst' }])
    expect(text).toContain('$A000')
    expect(text).toContain('main')
    expect(text).toContain('KC Monitor.lst')
  })

  it('prints something readable for an empty list', () => {
    expect(formatSymbols([])).toBe('(no symbols)')
  })
})

/**
 * The three formatters with no counterpart in 6502-EMULATOR, because the
 * hardware they describe has none: a 16x2 character LCD where the video card
 * was, and a 24-key pad where the keyboard and the joysticks were.
 */

describe('formatLCD', () => {
  it('boxes the panel so trailing blanks are visible', () => {
    // A line reading "0800" and one reading "0800" plus twelve spaces are
    // different states of the machine, and only the box shows it.
    const text = formatLCD(['---$0800: $00---', '                '])
    expect(text.split('\n')).toEqual([
      '+----------------+',
      '|---$0800: $00---|',
      '|                |',
      '+----------------+'
    ])
  })

  it('pads a short line out to the widest one', () => {
    expect(formatLCD(['KIM', 'MONITOR'])).toContain('|KIM    |')
  })
})

describe('formatLCDPixels', () => {
  it('draws lit dots, unlit dots and the gap between cells differently', () => {
    // The unlit dots are the point: on this display every dot position is
    // visible, so a rendering that only drew the lit ones would be a font
    // rather than a dot matrix. -1 arrives as 255, having been a signed byte.
    const text = formatLCDPixels({
      width: 3,
      height: 2,
      data: Uint8Array.from([1, 0, 255, 0, 1, 255])
    })
    expect(text.split('\n')).toEqual(['#. ', '.# '])
  })
})

describe('formatKeypad', () => {
  const keys = KEYPAD.map((key) => ({
    code: key.code,
    label: key.label,
    glyph: key.glyph,
    ...(key.value === undefined ? {} : { value: key.value }),
    row: key.row,
    col: key.col
  }))

  it('lays the pad out as it sits, four across and six down', () => {
    const lines = formatKeypad(keys).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatch(/^ESC\s+\$10\s+INS\s+\$11\s+PGUP\s+\$12\s+A\s+\$13$/)
  })

  /**
   * The code is not the key's value, which is the whole reason this is printed
   * in the pad's own layout rather than as a sorted list: `0` reports $0A, and
   * `C` to `F` run backwards.
   */
  it('shows the encoder code rather than the digit on the cap', () => {
    const zero = formatKeypad(keys)
      .split('\n')[5]!
      .match(/0\s+(\$[0-9A-F]{2})/)
    expect(zero![1]).toBe('$0A')
  })
})
