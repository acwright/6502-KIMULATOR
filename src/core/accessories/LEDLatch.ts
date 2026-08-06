import { IO } from '../IO'
import { expectKind, readNumber } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * The KIM Demo: eight LEDs behind a 74HC373 octal latch.
 *
 * The whole circuit, from `Kicad/KIM Demo`: the backplane's slot select for
 * io6 is gated with R/W and PHI2 into the '373's LE, and each output drives an
 * LED through a 330 Ω resistor to ground. That is the entire card — a write
 * strobe and eight lamps.
 *
 * Two consequences follow from the parts list, and both of them are the reason
 * this file exists rather than a convenient two-liner:
 *
 * **Reads return open bus.** There is no '245 and no OE onto the data bus, so
 * nothing drives the bus when the CPU reads the window. This is not a shortcut
 * taken for simplicity — it is load-bearing. `ProbeGPIO` in the BIOS writes $AA
 * to `GPIO_DDRB` ($9402, inside this window) and reads it back; a card that
 * echoed the write would pass that test and set `HW_GPIO` on a machine with no
 * VIA in it. `SysDelay` would then wait on a hardware timer that is not there.
 *
 * **A reset does not clear it.** A 74HC373 has no clear pin — it physically
 * cannot be reset, whatever RESET is wired to — so the lamps hold their last
 * value across the reset button, exactly as on the breadboard. Only power-off
 * empties the latch.
 *
 * Bit 7 is the leftmost lamp and bit 0 the rightmost, which is how the DOCS
 * cards describe reading them.
 */
export class LEDLatch implements IO {

  /**
   * Its `IO.kind`, and its registry id — see `accessories/Accessory.ts`. One
   * string, so a snapshot's slot check and the accessory's identity cannot drift
   * apart.
   */
  static readonly ID = 'led-latch'

  /** How many lamps the '373 drives. */
  static readonly LAMPS = 8

  readonly kind: string = LEDLatch.ID

  /** What the '373 is holding, and therefore which lamps are lit. */
  private latched: number = 0

  /**
   * Open bus.
   *
   * Deliberately not the latched byte: see the note above about `ProbeGPIO`.
   */
  read(address: number): number {
    return 0
  }

  /**
   * Any address in the window latches — LE is gated from the slot select and
   * R/W alone, with no address lines below A10 reaching the card at all.
   *
   * Which is why `ProbeGPIO`'s write to $9402 flickers the lamps on every boot,
   * and its `stz` immediately afterwards puts them out again.
   */
  write(address: number, data: number): void {
    this.latched = data & 0xff
  }

  /** Nothing clocked, nothing to interrupt with. */
  tick(frequency: number): number {
    return 0
  }

  reset(coldStart: boolean): void {
    // A '373 has no clear pin, so only removing power empties it.
    if (coldStart) this.latched = 0
  }

  /** The byte on the lamps. */
  get byte(): number {
    return this.latched
  }

  /** Whether lamp `bit` is lit — bit 7 is the leftmost. */
  lit(bit: number): boolean {
    return (this.latched & (1 << bit)) !== 0
  }

  serialize(): DeviceState {
    return {
      kind: this.kind,
      latched: this.latched
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    this.latched = readNumber(state, 'latched') & 0xff
  }

}
