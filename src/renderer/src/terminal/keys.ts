/**
 * What a key typed at the terminal puts on the wire.
 *
 * The panel is a serial port, not a keyboard: there is no scan code and no key
 * release, only the bytes a real terminal would send down the cable. So this is
 * deliberately small — the KC Monitor's serial monitor reads printable ASCII, a
 * carriage return to run a line, a backspace to rub one out, and ESC to stop.
 *
 * A key with a modifier on it is left alone. Cmd+C has to stay copy, Ctrl+R has
 * to stay reload; anything this does not claim falls through to the browser,
 * which is the whole reason the focus router only prevents the default on keys
 * a panel actually consumed.
 */

export const CHAR_BS = 0x08
export const CHAR_CR = 0x0d
export const CHAR_ESC = 0x1b

/**
 * The byte a `keydown` sends, or null when the terminal does not claim the key.
 *
 * Takes the fields it reads rather than a whole `KeyboardEvent`, so the mapping
 * can be checked without a DOM.
 */
export function byteForKey(event: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null

  switch (event.key) {
    case 'Enter':
      // The monitor's line loop ends on CR, and echoes it back as CR + LF.
      return CHAR_CR
    case 'Backspace':
      return CHAR_BS
    case 'Escape':
      return CHAR_ESC
    case 'Tab':
      // The focus router's, for cycling panels. Never the machine's.
      return null
  }

  // Everything else is a character or it is not ours. `key` is one code unit
  // wide exactly for the printable keys; 'ArrowUp' and 'F5' are longer and fall
  // through to the browser.
  if (event.key.length !== 1) return null
  const byte = event.key.charCodeAt(0)
  return byte >= 0x20 && byte <= 0x7e ? byte : null
}
