/**
 * Raw binaries.
 *
 * The ACE's side of this module also dealt in *program images* — the tokenized
 * BASIC line chain a `.prg` or `.bas` holds at $0800, and the end-of-program
 * pointer fixup that BASIC's own LOAD performs afterwards. None of that has any
 * meaning on a KIM: the Keypad Card's ROM replaces BASIC, so there is no
 * interpreter to hold a line chain, no workspace pointers to move, and no file
 * to load into it.
 *
 * What remains is BLOAD, which is the whole of it: bytes at an address, the
 * type-in cards without the typing.
 */

/** The subset of Machine this module needs. */
export interface MemoryBus {
  read(address: number): number
  write(address: number, data: number): void
}

/** $8000 and up is I/O, so RAM ends here. */
const RAM_TOP = 0x8000

export type BinaryLoadStatus = 'ok' | 'empty' | 'out-of-range'

/**
 * BLOAD: raw bytes to an explicit address.
 *
 * Deliberately permissive about the destination — BLOAD on the real machine will
 * write anywhere in RAM, including zero page and the Kernal workspace — but it
 * will not run off the top of RAM into the I/O space.
 */
export function loadBinary(
  bus: MemoryBus,
  address: number,
  bytes: Uint8Array
): BinaryLoadStatus {
  if (bytes.length === 0) return 'empty'
  if (address < 0 || address + bytes.length > RAM_TOP) return 'out-of-range'

  for (let i = 0; i < bytes.length; i++) {
    bus.write(address + i, bytes[i]!)
  }
  return 'ok'
}
