import { byteForKey, CHAR_BS, CHAR_CR, CHAR_ESC } from '../../renderer/src/terminal/keys'

/**
 * What a key typed at the terminal puts on the wire.
 *
 * The half that matters is what this *refuses*: the focus router prevents the
 * default only for keys a panel claimed, so anything returning null here is a
 * browser or Electron shortcut that still works while the terminal has the
 * keyboard.
 */
describe('byteForKey', () => {
  it('sends printable ASCII as itself', () => {
    expect(byteForKey({ key: 'A' })).toBe(0x41)
    expect(byteForKey({ key: 'a' })).toBe(0x61)
    expect(byteForKey({ key: '0' })).toBe(0x30)
    expect(byteForKey({ key: ' ' })).toBe(0x20)
    expect(byteForKey({ key: ':' })).toBe(0x3a)
    expect(byteForKey({ key: '~' })).toBe(0x7e)
  })

  it('ends a line with CR, which is what the monitor’s line loop waits for', () => {
    expect(byteForKey({ key: 'Enter' })).toBe(CHAR_CR)
  })

  it('rubs a character out with BS', () => {
    expect(byteForKey({ key: 'Backspace' })).toBe(CHAR_BS)
  })

  it('sends ESC, which is how a running program is stopped', () => {
    expect(byteForKey({ key: 'Escape' })).toBe(CHAR_ESC)
  })

  it('leaves Tab to the focus router', () => {
    expect(byteForKey({ key: 'Tab' })).toBeNull()
  })

  it('leaves modified keys alone, so the shortcuts still work', () => {
    expect(byteForKey({ key: 'c', metaKey: true })).toBeNull()
    expect(byteForKey({ key: 'r', ctrlKey: true })).toBeNull()
    expect(byteForKey({ key: 'a', altKey: true })).toBeNull()
    // Shift is not a modifier here: it is how a capital arrives at all.
    expect(byteForKey({ key: 'A', ctrlKey: false, metaKey: false, altKey: false })).toBe(0x41)
  })

  it('claims no named key it has no byte for', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'F5', 'F11', 'Home', 'PageUp', 'Shift', 'Dead']) {
      expect(byteForKey({ key })).toBeNull()
    }
  })

  it('drops a character outside printable ASCII', () => {
    expect(byteForKey({ key: '£' })).toBeNull()
    expect(byteForKey({ key: 'é' })).toBeNull()
  })
})
