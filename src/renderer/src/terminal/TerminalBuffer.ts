/**
 * What the serial port has said, and where the cursor is.
 *
 * A tap on the ACIA byte stream rather than a device: nothing in here is wired
 * to the machine, and `write` is called with exactly the bytes the ACIA
 * transmitted — the same bytes that go down a real cable when one is connected.
 * That is what makes the panel and a plugged-in laptop show the same traffic.
 *
 * There is no DOM in this file on purpose. The panel is a canvas over `line()`
 * and `cursor`, the debug protocol's `serial.read` is `read()`, and both are
 * reading the *same* buffer — a second, invisible one would mean a debug client
 * and the window disagreeing about what the machine has said.
 */

/** The panel is 40 × 24, and the KC Monitor's output is written for it. */
export const TERMINAL_COLS = 40
export const TERMINAL_ROWS = 24

/**
 * How many lines are kept above the screen. A few hundred: enough that a memory
 * dump can be scrolled back to and copied out, bounded so a machine left running
 * overnight does not grow without end.
 */
export const TERMINAL_SCROLLBACK = 400

/**
 * How much raw output `read()` can reach back through, in bytes.
 *
 * Separate from the scrollback because it answers a different question. The
 * screen is what the machine drew; this is what it *said*, control codes and
 * all, which is what a scripted client matches against.
 */
const STREAM_LIMIT = 64 * 1024

const CHAR_BS = 0x08
const CHAR_LF = 0x0a
const CHAR_CR = 0x0d

/** Everything the panel draws. Anything else is dropped rather than shown. */
function isPrintable(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e
}

export class TerminalBuffer {
  readonly cols: number
  readonly rows: number
  readonly scrollback: number

  /**
   * Every line the terminal has, oldest first, each `cols` characters wide.
   * The last `rows` of them are the screen; everything before is scrollback.
   */
  private lines: string[][] = []

  /** Where the next printable character lands: an index into `lines`, and a column. */
  private line = 0
  private column = 0

  /** Total bytes written, ever. A position in the output stream — see read(). */
  private produced = 0

  /** The tail of the raw stream, capped at STREAM_LIMIT. */
  private stream = ''

  /** Bumped on every change, so a renderer can skip a frame that would redraw the same thing. */
  private revision = 0

  private listeners = new Set<(bytes: Uint8Array) => void>()

  constructor(
    cols: number = TERMINAL_COLS,
    rows: number = TERMINAL_ROWS,
    scrollback: number = TERMINAL_SCROLLBACK
  ) {
    this.cols = cols
    this.rows = rows
    this.scrollback = scrollback
    this.clear()
  }

  /** Wipe the screen, the scrollback and the stream. Not a machine reset. */
  clear(): void {
    this.lines = []
    for (let i = 0; i < this.rows; i++) this.lines.push(this.blankLine())
    this.line = 0
    this.column = 0
    this.stream = ''
    this.revision++
  }

  private blankLine(): string[] {
    return new Array<string>(this.cols).fill(' ')
  }

  // ── Writing ────────────────────────────────────────────────────────────────

  /**
   * Take bytes from the machine.
   *
   * `CR` returns to the left margin, `LF` moves down a line and `BS` steps back
   * one column and rubs the character out — the KC Monitor's `SerEcho` maps a CR
   * to CR + LF on its way out, so the two arrive as a pair and a bare LF from
   * something else still behaves the way a terminal does. Everything else
   * outside $20-$7E is dropped: rendering a control code as a glyph would put
   * characters on the screen the machine never sent.
   */
  write(data: Uint8Array | number[] | number): void {
    const bytes = typeof data === 'number' ? [data] : data
    if (bytes.length === 0) return

    for (const raw of bytes) {
      const byte = raw & 0xff
      this.produced++
      this.stream += String.fromCharCode(byte)

      switch (byte) {
        case CHAR_CR:
          this.column = 0
          break
        case CHAR_LF:
          this.newline()
          break
        case CHAR_BS:
          this.backspace()
          break
        default:
          if (isPrintable(byte)) this.put(String.fromCharCode(byte))
      }
    }

    if (this.stream.length > STREAM_LIMIT) {
      this.stream = this.stream.slice(this.stream.length - STREAM_LIMIT)
    }

    this.revision++
    if (this.listeners.size > 0) {
      const copy = Uint8Array.from(bytes, (byte) => byte & 0xff)
      for (const listener of this.listeners) listener(copy)
    }
  }

  private put(character: string): void {
    // A character arriving with the cursor already past the right margin wraps
    // rather than overwriting the last column, so a dump wider than the panel
    // stays readable instead of piling up in column 39.
    if (this.column >= this.cols) {
      this.column = 0
      this.newline()
    }
    this.lines[this.line]![this.column] = character
    this.column++
  }

  private newline(): void {
    this.line++
    // Past the bottom of the screen: add a line and let the top scroll away.
    if (this.line >= this.lines.length) {
      this.lines.push(this.blankLine())
      const limit = this.rows + this.scrollback
      if (this.lines.length > limit) {
        const dropped = this.lines.length - limit
        this.lines.splice(0, dropped)
        this.line -= dropped
      }
    }
  }

  private backspace(): void {
    if (this.column === 0) return
    this.column--
    this.lines[this.line]![this.column] = ' '
  }

  // ── Reading, for the panel ─────────────────────────────────────────────────

  /** Where the top of the screen sits in `lines`. */
  private get top(): number {
    return Math.max(0, this.lines.length - this.rows)
  }

  /** One row of the visible screen, 0 at the top. */
  row(index: number): string {
    return (this.lines[this.top + index] ?? this.blankLine()).join('')
  }

  /** The whole visible screen, one string per row. */
  screen(): string[] {
    const out: string[] = []
    for (let i = 0; i < this.rows; i++) out.push(this.row(i))
    return out
  }

  /**
   * The cursor, in screen coordinates. `row` can fall outside the screen only if
   * the buffer is mid-scroll, which it never is by the time a frame is drawn.
   */
  get cursor(): { row: number; column: number } {
    return { row: this.line - this.top, column: Math.min(this.column, this.cols - 1) }
  }

  /** Screen and scrollback as text, trailing blanks trimmed — the copy action. */
  text(): string {
    return this.lines
      .map((line) => line.join('').replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n+$/, '')
  }

  /** Changes so far. Equal revisions mean an identical screen. */
  get version(): number {
    return this.revision
  }

  // ── Reading, for the debug protocol ────────────────────────────────────────

  /** How many bytes the console has produced. A position in the output stream. */
  get cursorPosition(): number {
    return this.produced
  }

  /**
   * Retained output, positioned in the stream it came from.
   *
   * `since` reads from an absolute position, which is what makes "wait for the
   * reply to what I just sent" reliable — between one RPC call and the next the
   * machine can run millions of cycles, so the reply routinely arrives before a
   * listener could be attached.
   */
  read(options: { since?: number; max?: number; clear?: boolean } = {}): {
    data: string
    cursor: number
    truncated: boolean
  } {
    // Where the retained tail starts in the stream. Anything before this has
    // been trimmed and cannot be recovered.
    const base = this.produced - this.stream.length

    let data = this.stream
    let truncated = false

    if (options.since !== undefined) {
      truncated = options.since < base
      data = this.stream.slice(Math.max(0, options.since - base))
    }
    if (options.max !== undefined) data = data.slice(-options.max)

    if (options.clear) this.stream = ''
    return { data, cursor: this.produced, truncated }
  }

  /** Subscribe to output as it is produced. Returns an unsubscribe. */
  onOutput(listener: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
