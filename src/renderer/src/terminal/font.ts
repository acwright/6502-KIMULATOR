/**
 * The character generator, borrowed from the ACE.
 *
 * The terminal is a serial console and could have been drawn in any face the
 * host happened to have. It is drawn in this one because the two machines are
 * the same family and should look it: these are the exact 8-byte glyphs the ACE
 * BIOS seeds its video card's pattern table with at $B800, so a line of text
 * here and a line of text in 6502-EMULATOR are the same picture.
 *
 * All 256 CP437 code points are here even though the panel only ever draws
 * $20-$7E — TerminalBuffer drops everything else, because rendering a control
 * code as a glyph would put characters on the screen the machine never sent.
 * The rest is kept so the table stays the BIOS's table rather than a subset of
 * it, and so a future panel that wants the box-drawing half has it.
 *
 * Each glyph is eight rows of eight bits, high bit leftmost, drawn five wide and
 * left-aligned in the byte. **The cell is the top six bits**, not five and not
 * eight: bits 1-0 are clear in all 2,048 rows of the table, and bit 2 is set
 * only in the box-drawing glyphs — which is exactly the column their lines need
 * to reach the next cell. So six is the width the character set was drawn for,
 * it carries its own inter-character gap, and it is the cell the ACE's text mode
 * puts on screen. See `terminal/render.ts`.
 *
 * Regenerated from `6502-DOCS/data/charset.json`, which the docs extractor pulls
 * out of the BIOS's `Chars.asm`. It is firmware data, not a font file: if the
 * BIOS's character set changes, this is re-extracted rather than edited.
 */

/** Bytes per glyph, and rows per glyph — the table is square. */
export const GLYPH_ROWS = 8

/**
 * The cell the panel draws a glyph into.
 *
 * Six wide rather than eight: the glyphs are five wide, and the sixth column is
 * the gap between characters. Eight would space the text like a typewriter with
 * a stuck bar.
 */
export const GLYPH_WIDTH = 6
export const GLYPH_HEIGHT = 8

/** 256 glyphs × 8 rows, base64'd so the table stays one screen instead of forty. */
const ENCODED =
  'AAAAAAAAAABwiNiIqIhwAHD4qPiI+HAAAFD4+PhwIAAAIHD4+HAgACBwcCD4+CAAACBw+Pgg' +
  'cAAAAAAwMAAAAPz8/MzM/Pz8AAB4SEh4AAD8/IS0tIT8/AA4GGiQkGAAcIiIcCBwIAAgMCgg' +
  'YODAABhoWGhY2MAAAKhw2HCoAABAYHB4cGBAABAwcPBwMBAAIHD4IPhwIABQUFBQUABQAHio' +
  'qGgoKCgAcIhgUDCIcAAAAAAAAPDwACBw+CD4cCBwIHD4ICAgIAAgICAg+HAgAAAgMPgwIAAA' +
  'ACBg+GAgAAAAAACAgID4AABQUPhQUAAAICBwcPj4AAD4+HBwICAAAAAAAAAAAAAAIHBwICAA' +
  'IADY2JAAAAAAAABQ+FBQ+FAAQHCAYBDgIADIyBAgQJiYAECgoECokGgAwMCAAAAAAABAgICA' +
  'gIBAAIBAQEBAQIAAAFBw+HBQAAAAICD4ICAAAAAAAAAAwMCAAAAA+AAAAAAAAAAAAMDAAAAI' +
  'ECBAgAAAcIiYqMiIcAAgYCAgICBwAHCICDBAgPgAcIgIcAiIcAAQMFCQ+BAQAPiAgPAIiHAA' +
  'MECA8IiIcAD4CBAgQEBAAHCIiHCIiHAAcIiIeAgQYAAAAGBgAGBgAAAAYGAAYGBAECBAgEAg' +
  'EAAAAPgAAPgAAIBAIBAgQIAAcIgIMCAAIABwiLiouIBwAHCIiIj4iIgA8IiI8IiI8ABwiICA' +
  'gIhwAPCIiIiIiPAA+ICA8ICA+AD4gIDwgICAAHCIgLiIiHgAiIiI+IiIiABwICAgICBwAAgI' +
  'CAiIiHAAiJCgwKCQiACAgICAgID4AIjYqIiIiIgAiMiomIiIiABwiIiIiIhwAPCIiPCAgIAA' +
  'cIiIiKiQaADwiIjwkIiIAHCIgHAIiHAA+CAgICAgIACIiIiIiIhwAIiIiIiIUCAAiIioqKio' +
  'UACIiFAgUIiIAIiIiFAgICAA8BAgQICA8ABwQEBAQEBwAACAQCAQCAAAcBAQEBAQcAAgUIgA' +
  'AAAAAAAAAAAAAAD4YGAgAAAAAAAAAHAIeIh4AICA8IiIiPAAAABwiICIcAAICHiIiIh4AAAA' +
  'cIjwgHAAMEBA8EBAQAAAAHiIiHgIcICA4JCQkJAAIAAgICAgMAAQADAQEBCQYICAkKDAoJAA' +
  'ICAgICAgMAAAANCoqIiIAAAA4JCQkJAAAABwiIiIcAAAAPCIiIjwgAAAcIiIiHgIAACwSEBA' +
  '4AAAAHCAcAhwAABA8EBAUCAAAACQkJCwUAAAAIiIiFAgAAAAiIio+FAAAACQkGCQkAAAAJCQ' +
  'kHAgwAAA8BBggPAAMEBAwEBAMAAgICAAICAgAMAgIDAgIMAAUKAAAAAAAAAgcNiIiPgAAHCI' +
  'gICIcCBgkACQkJCwUAAYAHCI8IBwAHAAcAh4iHgAUABwCHiIeABgAHAIeIh4AHBQcAh4iHgA' +
  'AHCIgIhwIGBwAHCI8IBwAFAAcIjwgHAAYABwiPCAcABQACAgICAwACBQACAgIDAAQAAgICAg' +
  'MABQACBQiPiIAHBQcNiI+IgAGAD4gPCA+AAAAPAo+KB4AHigoPigoLgAcABgkJCQYABQAGCQ' +
  'kJBgAMAAYJCQkGAAcACQkJCwUADAAJCQkLBQAFAAkJCQcCDAkGCQkJCQYABQAJCQkJBgAAAg' +
  'cICAcCAAMEhA8EBIuACIUCD4IPggAMCgoNC4kJAAECggcCAgoEAwAHAIeIh4AGAAQEBAQGAA' +
  'MABgkJCQYAAwAJCQkLBQAFCgAOCQkJAAUKAAkNCwkABwCHiIeAB4AGCQkJBgAPAAIAAgYICI' +
  'cAAAAPyAgIAAAAAA/AQEBAAAgJCgcIgQOACAkKBYqDgIACAAICBwcCAAAABIkEgAAAAAAJBI' +
  'kAAAAFQAqABUAKgAVKhUqFSoVKio/FT8qPxU/BAQEBAQEBAQEBAQ8BAQEBAQ8BDwEBAQEFBQ' +
  'UNBQUFBQAAAA8FBQUFAA8BDwEBAQEFDQENBQUFBQUFBQUFBQUFAA8BDQUFBQUFDQEPAAAAAA' +
  'UFBQ8AAAAAAQ8BDwAAAAAAAAAPAQEBAQEBAQHAAAAAAQEBD8AAAAAAAAAPwQEBAQEBAQHBAQ' +
  'EBAAAAD8AAAAABAQEPwQEBAQEBwQHBAQEBBQUFBcUFBQUFBcQHwAAAAAAHxAXFBQUFBQ3AD8' +
  'AAAAAAD8ANxQUFBQUFxAXFBQUFAA/AD8AAAAAFDcANxQUFBQEPwA/AAAAABQUFD8AAAAAAD8' +
  'APwQEBAQAAAA/FBQUFBQUFB8AAAAABAcEBwAAAAAABwQHBAQEBAAAAB8UFBQUFBQUNxQUFBQ' +
  'EPwA/BAQEBAQEBDwAAAAAAAAABwQEBAQ/Pz8/Pz8/PwAAAAA/Pz8/ODg4ODg4ODgHBwcHBwc' +
  'HBz8/Pz8AAAAAABokJBoAAAAAOCQ4JCQ4IDwkICAgICAAAD4UFBQUFAA8JBAIECQ8AAAAHiQ' +
  'kGAAAAAAkJCQ4ICAAABQoCAgIABwIHCIcCBwAGCQkPCQkGAAAHCIiFBQ2ABggEAgcJBgAAAA' +
  'UKioUAAAACBwqKhwIAAAcIDwgHAAAABgkJCQkAAAAPAA8ADwAAAAIHAgAHAAAIBgEGCAAPAA' +
  'EGCAYBAA8AAAECggICAgICAgICAgoEAAACAA+AAgAAAAUKAAUKAAAGCQkGAAAAAAAAAAYGAA' +
  'AAAAAABAAAAAAAA4ICCgoEAAoFBQUAAAAADAIEDgAAAAAAAAeHh4eAAAAAAAAAAAAAA='

function decode(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The whole table: `CHARACTER_ROM[code * GLYPH_ROWS + row]`. */
export const CHARACTER_ROM = decode(ENCODED)

/**
 * One row of one glyph, as eight bits with the leftmost pixel in bit 7.
 *
 * Anything outside 0-255 draws blank rather than throwing: the panel takes its
 * codes from a byte stream, and a stream is allowed to say anything.
 */
export function glyphRow(code: number, row: number): number {
  if (code < 0 || code > 0xff || row < 0 || row >= GLYPH_ROWS) return 0
  return CHARACTER_ROM[code * GLYPH_ROWS + row] ?? 0
}
