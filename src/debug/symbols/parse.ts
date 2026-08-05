import { SymbolTable } from './Symbols'

/**
 * Parsers for the label formats 6502 assemblers emit.
 *
 * VICE labels first, because ca65, 64tass and ACME can all produce them — it is
 * the lowest common denominator and enough for symbolic disassembly and
 * `break main`. The ca65 debug file is the richer one, and the only one here
 * that carries source line numbers.
 *
 * The ca65 *listing* is third, and it is here because of what this machine is.
 * The BIOS is built with `ld65 --dbgfile` and ships a `BIOS.dbg`; the Keypad
 * Card's firmware is built by `cl65 -l` and ships a `KC Monitor.lst` and no
 * debug file at all. Refusing it would mean the one ROM a KIM session most wants
 * symbols for is the one ROM it cannot have them for.
 */

/**
 * VICE label file:
 *
 *   al C:0800 .start
 *   al 00C012 .PrintChar
 *   add_label C:1234 .foo
 *
 * `al` is add-label, the optional `C:` names the memory space (the computer,
 * as opposed to a disk drive), and the leading dot on the name is VICE's own
 * marker rather than part of the label.
 */
export function parseViceLabels(text: string, source = 'vice'): SymbolTable {
  const table = new SymbolTable()

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue

    const match = /^(?:al|add_label)\s+(?:[A-Za-z]:)?\$?([0-9a-fA-F]+)\s+\.?(\S+)/.exec(line)
    if (!match) continue

    table.add({ name: match[2]!, address: parseInt(match[1]!, 16), source })
  }

  return table
}

/** Split a ca65 attribute list — `id=0,name="x",val=0xC000` — into a map. */
function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Values may be quoted and contain commas, so scan rather than split.
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|[^,\s]*)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const value = match[2]!
    out[match[1]!] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value
  }
  return out
}

const num = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  const value = /^0x/i.test(text) ? parseInt(text.slice(2), 16) : Number(text)
  return Number.isFinite(value) ? value : undefined
}

/**
 * ca65 debug file (`ld65 --dbgfile`).
 *
 * Line-oriented records, each a type followed by attributes:
 *
 *   sym  id=0,name="main",val=0xC000,type=lab,...
 *   seg  id=0,name="CODE",start=0xC000,size=0x100,...
 *   span id=0,seg=0,start=0,size=3,...
 *   line id=0,file=0,line=10,span=0+1
 *   file id=0,name="main.s",...
 *
 * Addresses for source lines are indirect: a line names spans, a span is an
 * offset and size within a segment, and the segment carries the load address.
 * Resolving that chain is what turns a debug file into gutter breakpoints.
 */
export function parseCa65Dbg(text: string, source = 'ca65'): SymbolTable {
  const table = new SymbolTable()

  const files = new Map<number, string>()
  const segments = new Map<number, number>()
  const spans = new Map<number, { seg: number; start: number; size: number }>()
  const lineRecords: { file: number; line: number; spans: number[] }[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const [kind] = line.split(/\s+/, 1)
    const attrs = attributes(line.slice(kind!.length))

    switch (kind) {
      case 'sym': {
        const value = num(attrs.val)
        const name = attrs.name
        // Equates and imports have no address; only labels place code or data.
        if (name && value !== undefined) table.add({ name, address: value, source })
        break
      }
      case 'file': {
        const id = num(attrs.id)
        if (id !== undefined && attrs.name) files.set(id, attrs.name)
        break
      }
      case 'seg': {
        const id = num(attrs.id)
        const start = num(attrs.start)
        if (id !== undefined && start !== undefined) segments.set(id, start)
        break
      }
      case 'span': {
        const id = num(attrs.id)
        const seg = num(attrs.seg)
        const start = num(attrs.start)
        const size = num(attrs.size)
        if (id !== undefined && seg !== undefined && start !== undefined && size !== undefined) {
          spans.set(id, { seg, start, size })
        }
        break
      }
      case 'line': {
        const file = num(attrs.file)
        const lineNumber = num(attrs.line)
        // Multiple spans are joined with '+'.
        const ids = (attrs.span ?? '')
          .split('+')
          .map((part) => num(part))
          .filter((value): value is number => value !== undefined)
        if (file !== undefined && lineNumber !== undefined && ids.length > 0) {
          lineRecords.push({ file, line: lineNumber, spans: ids })
        }
        break
      }
    }
  }

  for (const record of lineRecords) {
    const name = files.get(record.file)
    if (!name) continue

    for (const spanId of record.spans) {
      const span = spans.get(spanId)
      if (!span) continue
      const base = segments.get(span.seg)
      if (base === undefined) continue

      for (let offset = 0; offset < span.size; offset++) {
        table.addLine(base + span.start + offset, { file: name, line: record.line })
      }
    }
  }

  return table
}

/**
 * Where each of the Keypad Card's segments is linked, from its `6502.cfg`.
 *
 * A listing counts from the start of a segment, not from an address — `CartReset`
 * sits at `000000r`, and the `r` is ca65 saying "relocatable, the linker decides".
 * The linker's decision is not in the listing, so it has to be supplied, and this
 * is the one that matters: the KC Monitor's own config, which places its code at
 * $E000 and its vectors at $FFFA.
 *
 * A listing from any other project is parsed the same way given its own map; a
 * segment with no entry here contributes its equates and none of its labels,
 * because a label placed at the wrong address is worse than a missing one.
 */
export const KC_MONITOR_SEGMENTS: Readonly<Record<string, number>> = {
  ROM: 0xe000,
  VECTORS: 0xfffa
}

/** `NNNNNN[r] <depth>  <object code>  <source>` — the object field is 13 wide. */
const LISTING_LINE = /^([0-9A-Fa-f]{6})(r?)\s+(\d+)\s\s/
const LISTING_SOURCE_COLUMN = 13

/**
 * ca65 listing file (`ca65 -l` / `cl65 -l`).
 *
 * Two kinds of line carry a symbol, and they have to be read differently:
 *
 *   000000r 1               CartReset:
 *   000042r 1               @WaitStart:
 *   000000r 2               Beep                := $A030
 *
 * A **label** takes its address from the location counter in the first column,
 * offset by wherever its segment is linked. An **equate** does not — the counter
 * on an equate's line is just wherever the assembler happened to be, which for
 * every one of the several hundred in `6502.inc` is zero. Its address is the
 * value on the right-hand side. Reading the column for both would put the entire
 * Kernal API at $E000.
 *
 * ca65's cheap local labels (`@name`) are scoped to the global above them and
 * are reused freely — there are a dozen `@Done`s in the KC Monitor — so they are
 * qualified with their parent: `DoLeft@NoBorrow`. Unqualified they would
 * collide, and the table would report whichever one was assembled last.
 *
 * Source line numbers are not recovered. The `.dbg` file carries the span/segment
 * chain that maps addresses to source lines; a listing does not, and inventing
 * the mapping from the listing's own line numbering would point at the listing
 * rather than at the `.asm` a person has open.
 */
export function parseCa65Listing(
  text: string,
  source = 'lst',
  segments: Readonly<Record<string, number>> = KC_MONITOR_SEGMENTS
): SymbolTable {
  const table = new SymbolTable()

  /** Undefined until the first `.segment`, which is where the equates live. */
  let base: number | undefined
  let parent: string | undefined

  for (const raw of text.split(/\r?\n/)) {
    const match = LISTING_LINE.exec(raw)
    if (!match) continue

    const line = raw.slice(match[0].length + LISTING_SOURCE_COLUMN)
    const offset = parseInt(match[1]!, 16)

    const segment = /^\s*\.segment\s+"([^"]+)"/.exec(line)
    if (segment) {
      base = segments[segment[1]!]
      parent = undefined
      continue
    }

    const equate = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:?=\s*\$([0-9A-Fa-f]+)\b/.exec(line)
    if (equate) {
      table.add({ name: equate[1]!, address: parseInt(equate[2]!, 16), source })
      continue
    }

    const global = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line)
    if (global) {
      parent = global[1]!
      if (base !== undefined) table.add({ name: parent, address: base + offset, source })
      continue
    }

    const local = /^\s*@([A-Za-z0-9_]+):/.exec(line)
    if (local && parent !== undefined && base !== undefined) {
      table.add({ name: `${parent}@${local[1]!}`, address: base + offset, source })
    }
  }

  return table
}

export type SymbolFormat = 'vice' | 'ca65' | 'lst'

/**
 * Guess a format from the file extension, defaulting to VICE labels.
 *
 * The two that matter on this machine are `BIOS.dbg` and `KC Monitor.lst`, which
 * are the files the two ROMs' builds actually produce.
 */
export function formatForPath(path: string): SymbolFormat {
  if (/\.dbg$/i.test(path)) return 'ca65'
  if (/\.lst$/i.test(path)) return 'lst'
  return 'vice'
}

export function parseSymbols(text: string, format: SymbolFormat, source?: string): SymbolTable {
  switch (format) {
    case 'ca65':
      return parseCa65Dbg(text, source)
    case 'lst':
      return parseCa65Listing(text, source)
    default:
      return parseViceLabels(text, source)
  }
}
