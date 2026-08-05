/**
 * The Keypad Card's ROM — an AT28C64, 8 KB at $E000, holding the KC Monitor.
 *
 * This stands where 6502-EMULATOR has `Cart`, and is deliberately not a port of
 * it: a `Cart` models a 32 KB VCS cartridge that can be inserted and removed,
 * and the KIM has no cartridge slot. The Keypad Card *is* the cartridge, it is
 * soldered in, and a machine without it is not a KIM. So there is no unload,
 * and no state in which the card is absent — only a `load` for pointing the
 * machine at a freshly built `KC Monitor.bin`.
 *
 * It overlays the top of the address space, which is why the machine decodes it
 * *before* the BIOS ROM, and why the vectors the CPU fetches at $FFFA are the
 * card's own rather than the BIOS's. Those live at offset $1FFA, the last six
 * bytes of the image.
 *
 * Reads take an offset from START, as ROM's do — the machine subtracts it.
 */
export class CardROM {

  static START: number = 0xE000
  static END: number = 0xFFFF
  static SIZE: number = CardROM.END - CardROM.START + 1  // 8192

  /** Where the CPU fetches NMI, RESET and IRQ — inside this image, not the BIOS. */
  static VECTORS: number = 0xFFFA

  data: number[] = [...Array(CardROM.SIZE)].fill(0x00)

  read(address: number): number {
    return this.data[address]
  }

  load(data: number[]): void {
    if (data.length != CardROM.SIZE) { return }

    this.data = data
  }
}
