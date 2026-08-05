import { KEY_FACES, GRID_STYLE } from '../../renderer/src/keypad/layout'
import { KEYPAD, KEYPAD_COLS, KEYPAD_ROWS, keyForHostCode } from '@core/KeypadMap'

/**
 * The wiring between the map and the panel.
 *
 * `KeypadMap.test.ts` already checks the pad against 6502-DOCS; this checks that
 * what gets drawn is that pad and not a second description of it. The thing it
 * is really guarding is the last assertion in each block: the cap you click and
 * the host key you press both reach the encoder code the map names, because a
 * panel that drew `0` and sent $00 would look perfect and key the wrong byte.
 */
describe('the keypad panel’s layout', () => {
  it('draws every key on the pad and no others', () => {
    expect(KEY_FACES).toHaveLength(KEYPAD.length)
    expect(KEY_FACES.map((face) => face.code)).toEqual(KEYPAD.map((key) => key.code))
  })

  it('sends the encoder’s code, not the value on the cap', () => {
    const zero = KEY_FACES.find((face) => face.label === '0')!
    const c = KEY_FACES.find((face) => face.label === 'C')!
    const f = KEY_FACES.find((face) => face.label === 'F')!

    expect(zero.code).toBe(0x0a)
    expect(c.code).toBe(0x0f)
    expect(f.code).toBe(0x0c)
  })

  it('shows the code it sends, in hex, for the tooltip', () => {
    const zero = KEY_FACES.find((face) => face.label === '0')!
    const left = KEY_FACES.find((face) => face.label === '◄')!

    expect(zero.hex).toBe('$0A')
    expect(left.hex).toBe('$00')
  })

  describe('colouring', () => {
    it('makes the sixteen keys with a hex value black on white', () => {
      const hex = KEY_FACES.filter((face) => face.kind === 'hex')

      expect(hex).toHaveLength(16)
      expect(hex.map((face) => face.label).sort()).toEqual(
        ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'].sort()
      )
    })

    it('makes the eight command keys white on black', () => {
      const fn = KEY_FACES.filter((face) => face.kind === 'function')

      expect(fn).toHaveLength(8)
      expect(fn.map((face) => face.label).sort()).toEqual(
        ['ESC', 'INS', 'PGUP', '▲', 'DEL', 'PGDN', '◄', '►'].sort()
      )
    })

    it('takes the split from the map’s value rather than from the label', () => {
      for (const face of KEY_FACES) {
        const key = KEYPAD.find((k) => k.code === face.code)!
        expect(face.kind).toBe(key.value === undefined ? 'function' : 'hex')
      }
    })
  })

  describe('legends', () => {
    it('gives an icon to the three arrow keys and to nothing else', () => {
      const arrows = KEY_FACES.filter((face) => face.arrow !== null)

      expect(arrows.map((face) => [face.label, face.arrow])).toEqual([
        ['▲', 'up'],
        ['◄', 'left'],
        ['►', 'right']
      ])
    })

    it('leaves ESC, INS, DEL, PGUP and PGDN as text', () => {
      for (const label of ['ESC', 'INS', 'DEL', 'PGUP', 'PGDN']) {
        expect(KEY_FACES.find((face) => face.label === label)!.arrow).toBeNull()
      }
    })
  })

  describe('the grid', () => {
    it('is 4 x 6', () => {
      expect(GRID_STYLE.gridTemplateColumns).toBe(`repeat(${KEYPAD_COLS}, 1fr)`)
      expect(GRID_STYLE.gridTemplateRows).toBe(`repeat(${KEYPAD_ROWS}, 1fr)`)
    })

    it('letterboxes rather than stretching, in both directions', () => {
      // Whichever axis runs out first wins, so the caps stay square in a tall
      // panel and in a wide one alike.
      expect(GRID_STYLE.width).toBe('min(100cqw, 100cqh * 4 / 6)')
      expect(GRID_STYLE.height).toBe('min(100cqh, 100cqw * 6 / 4)')
    })

    it('puts one cap in each of the twenty-four cells, counting from one', () => {
      const cells = KEY_FACES.map((face) => `${face.row},${face.column}`)

      expect(new Set(cells).size).toBe(24)
      expect(Math.min(...KEY_FACES.map((f) => f.row))).toBe(1)
      expect(Math.max(...KEY_FACES.map((f) => f.row))).toBe(KEYPAD_ROWS)
      expect(Math.min(...KEY_FACES.map((f) => f.column))).toBe(1)
      expect(Math.max(...KEY_FACES.map((f) => f.column))).toBe(KEYPAD_COLS)
    })

    it('lays the caps out the way the real pad is legended', () => {
      const at = (row: number, column: number) =>
        KEY_FACES.find((face) => face.row === row && face.column === column)!.label

      expect([at(1, 1), at(1, 2), at(1, 3), at(1, 4)]).toEqual(['ESC', 'INS', 'PGUP', 'A'])
      expect([at(6, 1), at(6, 2), at(6, 3), at(6, 4)]).toEqual(['◄', '0', '►', 'F'])
    })
  })

  describe('the host keyboard reaches the same caps', () => {
    it('routes every key the panel draws', () => {
      for (const face of KEY_FACES) {
        for (const hostCode of face.keys) {
          expect(keyForHostCode(hostCode)!.code).toBe(face.code)
        }
      }
    })

    it('leaves keys that are not on the pad to the browser', () => {
      expect(keyForHostCode('ArrowDown')).toBeUndefined()
      expect(keyForHostCode('KeyG')).toBeUndefined()
    })
  })
})
