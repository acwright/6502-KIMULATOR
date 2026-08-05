/**
 * CRC-32, written out rather than pulled from `node:zlib` / `node:crypto`.
 *
 * `createMethods()` — and therefore this module — runs in two places: the
 * headless host under plain Node, and the Electron renderer, which is a
 * browser context with no built-in `zlib` or `crypto` module. Node built-ins
 * would need a bundler polyfill of uncertain API coverage (`zlib.crc32` in
 * particular is a recent addition even Node polyfill packages may not carry);
 * twenty lines of portable arithmetic sidesteps the question entirely, and the
 * algorithm is simple enough that "written incorrectly" is not a real risk next
 * to "the polyfill doesn't have this export."
 *
 * 6502-EMULATOR's copy carries Adler-32 as well, for the trailer a zlib stream
 * needs. That was `PNG.ts`'s, and a 16x2 character display has nothing worth
 * encoding as a PNG, so neither comes across.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE 802.3) — what `lcd.hash` and the snapshot's ROM identities use. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
