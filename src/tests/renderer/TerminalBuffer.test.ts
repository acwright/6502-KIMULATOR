import { TerminalBuffer, TERMINAL_COLS, TERMINAL_ROWS } from '../../renderer/src/terminal/TerminalBuffer'

/**
 * The terminal's control-code handling, which is the whole of its behaviour —
 * everything else about the panel is a canvas.
 *
 * The KC Monitor's `SerEcho` maps a CR to CR + LF on the way out, so the pair is
 * what actually arrives; the tests below check each half on its own as well,
 * because a bare LF from anything else still has to behave like a terminal.
 */

const write = (buffer: TerminalBuffer, text: string): void => {
  buffer.write(Uint8Array.from(text, (c) => c.charCodeAt(0)))
}

describe('TerminalBuffer', () => {
  it('is 40 x 24, blank, with the cursor home', () => {
    const buffer = new TerminalBuffer()

    expect(buffer.cols).toBe(40)
    expect(buffer.rows).toBe(24)
    expect(buffer.screen()).toHaveLength(TERMINAL_ROWS)
    expect(buffer.row(0)).toBe(' '.repeat(TERMINAL_COLS))
    expect(buffer.cursor).toEqual({ row: 0, column: 0 })
  })

  it('prints ASCII and advances the cursor', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'KIM')

    expect(buffer.row(0).trimEnd()).toBe('KIM')
    expect(buffer.cursor).toEqual({ row: 0, column: 3 })
  })

  it('drops control codes it does not handle rather than drawing them', () => {
    const buffer = new TerminalBuffer()
    // BEL, VT, FF, ESC, DEL and a high byte — none of which is a glyph here.
    buffer.write([0x07, 0x41, 0x0b, 0x0c, 0x1b, 0x7f, 0x80, 0xff, 0x42])

    expect(buffer.row(0).trimEnd()).toBe('AB')
    expect(buffer.cursor).toEqual({ row: 0, column: 2 })
  })

  it('returns to the left margin on CR without moving down', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'ABCD\rE')

    expect(buffer.row(0).trimEnd()).toBe('EBCD')
    expect(buffer.cursor).toEqual({ row: 0, column: 1 })
  })

  it('moves down on LF without moving to the margin', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'AB\nC')

    expect(buffer.row(0).trimEnd()).toBe('AB')
    expect(buffer.row(1)).toBe('  C' + ' '.repeat(TERMINAL_COLS - 3))
    expect(buffer.cursor).toEqual({ row: 1, column: 3 })
  })

  it('starts the next line on CR + LF, which is what the monitor sends', () => {
    const buffer = new TerminalBuffer()
    write(buffer, '> 0800\r\n0800: A9')

    expect(buffer.row(0).trimEnd()).toBe('> 0800')
    expect(buffer.row(1).trimEnd()).toBe('0800: A9')
    expect(buffer.cursor).toEqual({ row: 1, column: 8 })
  })

  it('rubs the character out on BS, and stops at the margin', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'ABC\b\b')

    expect(buffer.row(0).trimEnd()).toBe('A')
    expect(buffer.cursor).toEqual({ row: 0, column: 1 })

    write(buffer, '\b\b\b\b')
    expect(buffer.cursor).toEqual({ row: 0, column: 0 })
    expect(buffer.row(0)).toBe(' '.repeat(TERMINAL_COLS))
  })

  it('wraps rather than piling up in the last column', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'X'.repeat(TERMINAL_COLS) + 'Y')

    expect(buffer.row(0)).toBe('X'.repeat(TERMINAL_COLS))
    expect(buffer.row(1).trimEnd()).toBe('Y')
  })

  it('scrolls at the bottom, keeping the last line on screen', () => {
    const buffer = new TerminalBuffer()
    for (let i = 0; i < TERMINAL_ROWS + 5; i++) write(buffer, `line${i}\r\n`)

    // 29 lines written, so the screen holds the last 23 of them plus the blank
    // line the final CR/LF left the cursor on — and line0 has scrolled off.
    expect(buffer.row(TERMINAL_ROWS - 2).trimEnd()).toBe(`line${TERMINAL_ROWS + 4}`)
    expect(buffer.cursor.row).toBe(TERMINAL_ROWS - 1)
    expect(buffer.row(0).trimEnd()).toBe('line6')
  })

  it('keeps scrolled-off lines in the text a copy would take', () => {
    const buffer = new TerminalBuffer()
    for (let i = 0; i < TERMINAL_ROWS + 5; i++) write(buffer, `line${i}\r\n`)

    expect(buffer.text().split('\n')[0]).toBe('line0')
  })

  it('bounds the scrollback, so a machine left running overnight cannot grow forever', () => {
    const buffer = new TerminalBuffer(TERMINAL_COLS, TERMINAL_ROWS, 10)
    for (let i = 0; i < 200; i++) write(buffer, `line${i}\r\n`)

    const lines = buffer.text().split('\n')
    // 34 kept — the screen plus the scrollback — of which the last is the blank
    // one the cursor sits on, and text() does not hand back a trailing blank.
    expect(lines).toHaveLength(TERMINAL_ROWS + 10 - 1)
    expect(lines[0]).toBe('line167')
  })

  describe('the stream the debug protocol reads', () => {
    it('counts every byte written, control codes included', () => {
      const buffer = new TerminalBuffer()
      write(buffer, 'AB\r\n')

      expect(buffer.cursorPosition).toBe(4)
      expect(buffer.read().data).toBe('AB\r\n')
    })

    it('reads from an absolute position, so a reply cannot be missed', () => {
      const buffer = new TerminalBuffer()
      write(buffer, '> ')
      const mark = buffer.cursorPosition

      write(buffer, '0800: A9\r\n')

      const read = buffer.read({ since: mark })
      expect(read.data).toBe('0800: A9\r\n')
      expect(read.cursor).toBe(buffer.cursorPosition)
      expect(read.truncated).toBe(false)
    })

    it('reports truncation when the requested position has been trimmed away', () => {
      const buffer = new TerminalBuffer()
      write(buffer, 'x'.repeat(70_000))

      expect(buffer.read({ since: 0 }).truncated).toBe(true)
    })

    it('clears what it returned when asked, without moving the cursor', () => {
      const buffer = new TerminalBuffer()
      write(buffer, 'hello')

      expect(buffer.read({ clear: true }).data).toBe('hello')
      expect(buffer.read().data).toBe('')
      // The stream position is a count of what was produced, not of what is kept.
      expect(buffer.cursorPosition).toBe(5)
    })

    it('announces output to listeners as it is produced', () => {
      const buffer = new TerminalBuffer()
      const heard: string[] = []
      const off = buffer.onOutput((bytes) => {
        heard.push(String.fromCharCode(...bytes))
      })

      write(buffer, 'ok')
      off()
      write(buffer, 'more')

      expect(heard).toEqual(['ok'])
    })
  })

  it('clear() wipes the screen, the scrollback and the retained stream', () => {
    const buffer = new TerminalBuffer()
    write(buffer, 'something\r\nelse')
    buffer.clear()

    expect(buffer.text()).toBe('')
    expect(buffer.cursor).toEqual({ row: 0, column: 0 })
    expect(buffer.read().data).toBe('')
  })
})
