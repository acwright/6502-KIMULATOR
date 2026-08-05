import { AttachmentBase } from './Attachment'
import { expectKind, readBoolean, readNumber } from '../../DeviceState'
import type { DeviceState } from '../../DeviceState'

/**
 * KeypadAttachment - Emulates a 4×6 matrix keypad with a built-in hardware encoder
 *
 * The encoder converts a key press into a 5-bit code (PA0–PA4) that appears on the PIA
 * port.  Bits 5–7 are never driven by the keypad and always read as 0 when data is present.
 *
 * Behaviour mirrors the MM74C922 on the Keypad Helper, extended to 24 keys with a 74HC00:
 * - On key press  → the 5-bit keypad code is latched and a CA1/CB1 interrupt is asserted
 * - On port read  → the latched code is returned on bits 0–4 (bits 5–7 = 0)
 * - clearInterrupts → clears the interrupt and the data-ready latch
 * - Key releases  → ignored (encoder only reports on the falling edge of a keypress)
 *
 * The attachment may be wired to either Port A or Port B via the constructor parameter.
 * On the Keypad Card it is Port A: CA1 is the DA (Data Available) line from the 74C922,
 * and CA2 is connected to its OE (Output Enable) pin, so data is only driven onto the
 * bus when OE is asserted LOW by the PIA.
 *
 * Ported from 6502-EMULATOR@d8b7882. The USB HID lookup that lived here has moved to
 * KeypadMap, which the UI, the CLI and this emulator's tests share — the encoder does
 * not know what is printed on the keycap, it knows a number, and so does this class.
 */
export class KeypadAttachment extends AttachmentBase {

  protected readonly kind = 'keypad'

  /** Valid encoder codes are $00–$17: 24 keys, no more. */
  static readonly KEY_COUNT = 24

  private keypadValue: number = 0x00
  private dataReady: boolean = false
  private interruptPending: boolean = false
  private readonly attachedToPortA: boolean

  // OE state: CA2 for Port A, CB2 for Port B.  HIGH = output disabled (default).
  private oeState: boolean = true

  constructor(attachToPortA: boolean = true, priority: number = 0) {
    super(priority, false, false, false, false)
    this.attachedToPortA = attachToPortA
    this.reset()
  }

  reset(): void {
    super.reset()
    this.keypadValue = 0x00
    this.dataReady = false
    this.interruptPending = false
    this.oeState = true  // OE disabled until explicitly asserted by the PIA
  }

  updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    // CA2 controls OE for Port A; CB2 controls OE for Port B.
    // 74C922 OE is active-LOW, so a LOW signal enables the output.
    this.oeState = this.attachedToPortA ? ca2 : cb2
  }

  readPortA(ddr: number, or: number): number {
    // Only drive the bus when attached to Port A, OE is asserted (LOW), and data is latched
    if (this.attachedToPortA && !this.oeState && this.dataReady) {
      return this.keypadValue & 0x1F  // bits 0–4 only; bits 5–7 = 0
    }
    return 0xFF  // not driving the bus
  }

  readPortB(ddr: number, or: number): number {
    // Only drive the bus when attached to Port B, OE is asserted (LOW), and data is latched
    if (!this.attachedToPortA && !this.oeState && this.dataReady) {
      return this.keypadValue & 0x1F  // bits 0–4 only; bits 5–7 = 0
    }
    return 0xFF  // not driving the bus
  }

  hasCA1Interrupt(): boolean {
    return this.attachedToPortA && this.interruptPending
  }

  hasCB1Interrupt(): boolean {
    return !this.attachedToPortA && this.interruptPending
  }

  clearInterrupts(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    if ((this.attachedToPortA && ca1) || (!this.attachedToPortA && cb1)) {
      this.interruptPending = false
      this.dataReady = false
    }
  }

  /**
   * Press a key on the pad.
   *
   * Takes the encoder's own 5-bit code, not a host keycode — see KeypadMap for
   * the translation. Codes outside $00–$17 are not on this pad and are dropped;
   * the 74C922 has no switch to close for them.
   *
   * There is no release. The encoder reports the press and nothing else, which
   * is why the KC Monitor can hold a key down without the code repeating.
   *
   * @param code - the encoder code, $00–$17
   */
  press(code: number): void {
    if (!Number.isInteger(code) || code < 0 || code >= KeypadAttachment.KEY_COUNT) {
      return  // key is not present on this keypad
    }

    this.keypadValue = code
    this.dataReady = true
    this.interruptPending = true
  }

  /**
   * Returns the current latched keypad code (bits 0–4) or 0xFF if no data is ready.
   */
  getCurrentKey(): number {
    return this.dataReady ? (this.keypadValue & 0x1F) : 0xFF
  }

  /** Returns true when a key has been pressed and the latch has not yet been cleared. */
  hasDataReady(): boolean {
    return this.dataReady
  }

  //
  // Snapshots
  //

  /**
   * The latch, the DA line and the OE level.
   *
   * A snapshot taken between the press and the interrupt handler's read is
   * holding a keystroke, and dropping it loses the key.
   *
   * `attachedToPortA` is not in here: it is which header the ribbon is plugged
   * into, restored by building the machine.
   */
  serialize(): DeviceState {
    return {
      ...super.serialize(),
      keypadValue: this.keypadValue,
      dataReady: this.dataReady,
      interruptPending: this.interruptPending,
      oeState: this.oeState
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)
    super.deserialize(state)
    this.keypadValue = readNumber(state, 'keypadValue')
    this.dataReady = readBoolean(state, 'dataReady')
    this.interruptPending = readBoolean(state, 'interruptPending')
    this.oeState = readBoolean(state, 'oeState')
  }
}
