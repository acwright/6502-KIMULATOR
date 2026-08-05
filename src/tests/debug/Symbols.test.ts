import { SymbolTable } from '../../debug/symbols/Symbols'
import {
  parseViceLabels,
  parseCa65Dbg,
  parseCa65Listing,
  parseSymbols,
  formatForPath
} from '../../debug/symbols/parse'
import { disassembleOne, formatInstruction } from '../../debug/Disassembler'

describe('SymbolTable', () => {
  let table: SymbolTable

  beforeEach(() => {
    table = new SymbolTable()
    table.add({ name: 'main', address: 0xc000 })
    table.add({ name: 'PrintChar', address: 0xa000 })
  })

  it('looks up in both directions', () => {
    expect(table.resolve('main')).toBe(0xc000)
    expect(table.nameFor(0xa000)).toBe('PrintChar')
  })

  it('reports nothing for an unknown name or address', () => {
    expect(table.resolve('nope')).toBeUndefined()
    expect(table.nameFor(0x1234)).toBeUndefined()
  })

  it('keeps the first name when several share an address', () => {
    table.add({ name: 'entry', address: 0xc000 })
    expect(table.nameFor(0xc000)).toBe('main')
    // Both still resolve by name.
    expect(table.resolve('entry')).toBe(0xc000)
  })

  it('finds the nearest symbol below an address, with its offset', () => {
    expect(table.nearest(0xc007)).toMatchObject({ offset: 7 })
    expect(table.nearest(0xc007)!.symbol.name).toBe('main')
  })

  it('does not let a distant symbol claim an unrelated address', () => {
    expect(table.nearest(0xc000 + 0x500)).toBeUndefined()
  })

  it('merges tables', () => {
    const other = new SymbolTable()
    other.add({ name: 'extra', address: 0x0400 })
    table.merge(other)
    expect(table.resolve('extra')).toBe(0x0400)
    expect(table.size).toBe(3)
  })
})

describe('VICE label files', () => {
  const sample = `
; a comment
al C:0800 .start
al C:C012 .PrintChar
al 00A000 .Chrout
add_label C:1234 .foo
not a label line
`

  it('parses labels, with or without a memory-space prefix', () => {
    const table = parseViceLabels(sample)

    expect(table.resolve('start')).toBe(0x0800)
    expect(table.resolve('PrintChar')).toBe(0xc012)
    expect(table.resolve('Chrout')).toBe(0xa000)
  })

  it('accepts the add_label spelling', () => {
    expect(parseViceLabels(sample).resolve('foo')).toBe(0x1234)
  })

  it('skips comments and anything unrecognised rather than failing', () => {
    expect(parseViceLabels(sample).size).toBe(4)
  })

  it('returns an empty table for empty input', () => {
    expect(parseViceLabels('').size).toBe(0)
  })
})

describe('ca65 debug files', () => {
  // A minimal but structurally real .dbg: CODE loads at $C000, span 0 covers
  // its first three bytes, and source line 10 of main.s maps to that span.
  const sample = `version	major=2,minor=0
info	csym=0,file=1,lib=0,line=2,mod=1,scope=1,seg=1,span=2,sym=2,type=0
file	id=0,name="main.s",size=100,mtime=0x00000000,mod=0
seg	id=0,name="CODE",start=0xC000,size=0x0010,addrsize=absolute,type=ro
span	id=0,seg=0,start=0,size=3
span	id=1,seg=0,start=3,size=2
line	id=0,file=0,line=10,span=0
line	id=1,file=0,line=11,span=1
sym	id=0,name="main",addrsize=absolute,size=3,scope=0,def=0,val=0xC000,type=lab
sym	id=1,name="loop",addrsize=absolute,scope=0,def=1,val=0xC003,type=lab
sym	id=2,name="MAXLEN",addrsize=absolute,scope=0,def=2,type=equ
`

  it('reads labels', () => {
    const table = parseCa65Dbg(sample)
    expect(table.resolve('main')).toBe(0xc000)
    expect(table.resolve('loop')).toBe(0xc003)
  })

  it('skips symbols with no address, like equates', () => {
    expect(parseCa65Dbg(sample).resolve('MAXLEN')).toBeUndefined()
  })

  // The chain from a source line to an address runs line -> span -> segment,
  // which is the part a DAP adapter needs to place a gutter breakpoint.
  it('maps source lines to addresses through spans and segments', () => {
    const table = parseCa65Dbg(sample)

    expect(table.lineFor(0xc000)).toEqual({ file: 'main.s', line: 10 })
    expect(table.lineFor(0xc002)).toEqual({ file: 'main.s', line: 10 })
    expect(table.lineFor(0xc003)).toEqual({ file: 'main.s', line: 11 })
    expect(table.lineFor(0xc004)).toEqual({ file: 'main.s', line: 11 })
  })

  it('has no line for an address outside any span', () => {
    expect(parseCa65Dbg(sample).lineFor(0xc00f)).toBeUndefined()
  })

  it('handles a line that spans several ranges', () => {
    // One line covering both spans, and nothing else claiming them.
    const multi = sample
      .replace('line\tid=0,file=0,line=10,span=0\n', 'line\tid=0,file=0,line=10,span=0+1\n')
      .replace('line\tid=1,file=0,line=11,span=1\n', '')

    const table = parseCa65Dbg(multi)
    expect(table.lineFor(0xc000)?.line).toBe(10)
    expect(table.lineFor(0xc004)?.line).toBe(10)
  })

  it('tolerates a truncated or unfamiliar file', () => {
    expect(() => parseCa65Dbg('version\tmajor=2,minor=0\ngarbage here\n')).not.toThrow()
    expect(parseCa65Dbg('').size).toBe(0)
  })
})

/**
 * The format the Keypad Card's firmware actually ships.
 *
 * `KC Monitor` is built by `cl65 -l` and produces a listing and no debug file,
 * so this is the only way a KIM session gets symbols for the ROM it spends most
 * of its time in.
 *
 * The fixture is transcribed from a real `KC Monitor.lst` rather than generated,
 * column widths included: the source text begins at a fixed offset past the
 * location counter, the nesting depth and the object-code field, and a parser
 * that guessed where it started would read `78` as an instruction on one line
 * and part of a label on the next.
 */
const LISTING = [
  'ca65 V2.19 - Git 0fca83500',
  'Main file   : KC Monitor.asm',
  'Current file: KC Monitor.asm',
  '',
  '000000r 1               .setcpu "65C02"',
  '000000r 1               .include "6502.inc"',
  '000000r 2               CF_BUF_PTR          := $24               ; 2 bytes',
  '000000r 2               Beep                := $A030             ; Play a beep',
  '000000r 2               KernalInit          := $A078',
  '000000r 1               .segment "ROM"',
  '000000r 1               CartReset:',
  '000000r 1  78             sei',
  '000001r 1  A2 FF          ldx #$ff',
  '000042r 1               @WaitStart:',
  '00004Dr 1               WarmStart:',
  '000062r 1               MonitorLoop:',
  '0000A6r 1               @Done:',
  '0001A7r 1               DoLeft:',
  '0001ADr 1               @Done:',
  '0004E7r 1               .segment "VECTORS"',
  '000000r 1  rr rr        .word   NmiVector',
  '000002r 1  rr rr        .word   CartReset'
].join('\n')

describe('ca65 listing files', () => {
  const table = parseCa65Listing(LISTING)

  it('places a label by its segment, not by the bare location counter', () => {
    expect(table.resolve('CartReset')).toBe(0xe000)
    expect(table.resolve('WarmStart')).toBe(0xe04d)
    expect(table.resolve('MonitorLoop')).toBe(0xe062)
  })

  /**
   * The mistake that would otherwise put the entire Kernal API at $E000: the
   * counter on an equate's line is wherever the assembler happened to be, which
   * for every one of the several hundred in `6502.inc` is zero. Its address is
   * the value on the right-hand side.
   */
  it('takes an equate from its value, never from the column', () => {
    expect(table.resolve('Beep')).toBe(0xa030)
    expect(table.resolve('KernalInit')).toBe(0xa078)
    expect(table.resolve('CF_BUF_PTR')).toBe(0x24)
  })

  it('qualifies cheap locals with their parent, because they repeat', () => {
    expect(table.resolve('MonitorLoop@Done')).toBe(0xe0a6)
    expect(table.resolve('DoLeft@Done')).toBe(0xe1ad)
    // Unqualified they would collide, and whichever came last would win.
    expect(table.resolve('@Done')).toBeUndefined()
  })

  it('follows the segment change, so the vectors are not stacked on the code', () => {
    expect(table.resolve('CartReset')).toBe(0xe000)
    // The VECTORS segment counts from zero again; $E000 is already taken.
    expect(table.list().filter((s) => s.address === 0xe000)).toHaveLength(1)
  })

  /**
   * A listing from another project links its segments somewhere else, and a
   * label placed at the wrong address is worse than a missing one — it sends a
   * breakpoint into the middle of an unrelated instruction.
   */
  it('drops labels from a segment it has no base for, and keeps the equates', () => {
    const elsewhere = parseCa65Listing(LISTING, 'lst', { VECTORS: 0xfffa })

    expect(elsewhere.resolve('CartReset')).toBeUndefined()
    expect(elsewhere.resolve('Beep')).toBe(0xa030)
  })

  it('ignores everything before the first segment, where the equates live', () => {
    // `.setcpu` and `.include` sit at 000000r too, and neither is a label.
    expect(table.resolve('setcpu')).toBeUndefined()
    expect(table.resolve('include')).toBeUndefined()
  })
})

describe('format selection', () => {
  it('picks ca65 for .dbg, the listing parser for .lst, and VICE otherwise', () => {
    expect(formatForPath('build/game.dbg')).toBe('ca65')
    expect(formatForPath('KC Monitor.lst')).toBe('lst')
    expect(formatForPath('BIOS.LST')).toBe('lst')
    expect(formatForPath('build/game.lbl')).toBe('vice')
    expect(formatForPath('labels.txt')).toBe('vice')
  })

  it('dispatches on the chosen format', () => {
    expect(parseSymbols('al C:C000 .main', 'vice').resolve('main')).toBe(0xc000)
    expect(parseSymbols(LISTING, 'lst').resolve('CartReset')).toBe(0xe000)
  })
})

describe('symbols in disassembly', () => {
  it('names a call target', () => {
    const table = parseViceLabels('al C:A000 .Chrout')
    const source = { read: (a: number) => [0x20, 0x00, 0xa0][a - 0xc000] ?? 0 }

    const instruction = disassembleOne(source, 0xc000, table.resolver())
    expect(formatInstruction(instruction, { bytes: false }).trim()).toBe('C000  JSR Chrout')
  })
})
