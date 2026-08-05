import { IO } from '../IO'
import { Attachment } from './Attachments/Attachment'
import { expectKind, readBoolean, readNumber, readStates } from '../DeviceState'
import type { DeviceState } from '../DeviceState'

/**
 * PIA - Emulates the 65C21 PIA (Peripheral Interface Adapter)
 *
 * The Keypad Card's one I/O chip. It provides:
 * - Two 8-bit bidirectional I/O ports (Port A and Port B)
 * - Two control lines per port (CA1/CA2, CB1/CB2)
 * - An interrupt flag per control line, latched in the control register
 *
 * On the KIM it sits at $C000, mirrored every four bytes across $C000-$DFFF,
 * and it carries both peripherals on the card:
 *
 *   PA0-PA4  keypad code from the 74C922 encoder   (inputs)
 *   PA5      LCD RS      PA6  LCD R/W    PA7  LCD E (outputs)
 *   PB0-PB7  the LCD's 8-bit data bus              (bidirectional)
 *   CA1      keypad data-available, an edge into CRA bit 7
 *   CA2      the encoder's active-low output enable, driven from CRA bits 3-5
 *
 * There are no timers and no shift register — that is the whole difference from
 * the 6522 in 6502-EMULATOR, and it is why this file is a third of VIA.ts.
 */
export class PIA implements IO {

  readonly kind = 'pia'

  // Register select — RS1:RS0 are A1:A0, so the four registers repeat every
  // four bytes across the whole window. PORTx and DDRx share an address and are
  // told apart by bit 2 of that port's control register.
  private static readonly PIA_PORTA = 0x00    // PORTA / DDRA
  private static readonly PIA_CRA   = 0x01    // Control Register A
  private static readonly PIA_PORTB = 0x02    // PORTB / DDRB
  private static readonly PIA_CRB   = 0x03    // Control Register B

  // Control register bits
  private static readonly CR_IRQ1_ENABLE   = 0x01  // bit 0: C1 interrupt enable
  private static readonly CR_IRQ1_POSITIVE = 0x02  // bit 1: C1 active edge, 1 = rising
  private static readonly CR_PORT_SELECT   = 0x04  // bit 2: 1 = PORTx, 0 = DDRx
  private static readonly CR_IRQ2_ENABLE   = 0x08  // bit 3: C2 interrupt enable (C2 input)
  private static readonly CR_C2_LEVEL      = 0x08  // bit 3: C2 output level (C2 manual output)
  private static readonly CR_IRQ2_POSITIVE = 0x10  // bit 4: C2 active edge (C2 input)
  private static readonly CR_C2_MANUAL     = 0x10  // bit 4: 1 = manual, 0 = handshake/pulse
  private static readonly CR_C2_OUTPUT     = 0x20  // bit 5: 1 = C2 is an output
  private static readonly CR_IRQ2_FLAG     = 0x40  // bit 6: C2 flag, read-only
  private static readonly CR_IRQ1_FLAG     = 0x80  // bit 7: C1 flag, read-only

  /** Bits 6 and 7 are set by the chip and cleared by a port read — never written. */
  private static readonly CR_FLAGS = PIA.CR_IRQ1_FLAG | PIA.CR_IRQ2_FLAG

  private static readonly MAX_ATTACHMENTS_PER_PORT = 8

  // PIA Registers
  private regORA: number = 0x00
  private regDDRA: number = 0x00
  private regCRA: number = 0x00
  private regORB: number = 0x00
  private regDDRB: number = 0x00
  private regCRB: number = 0x00

  // Control lines, as they sit right now
  private CA1: boolean = false
  private CA2: boolean = false
  private CB1: boolean = false
  private CB2: boolean = false

  /**
   * The previous level of each interrupt input, for edge detection.
   *
   * The 6522 latches a flag whenever a peripheral says it has one; the 65C21
   * latches on a *transition* in the direction CR bit 1 selects. That
   * difference matters here: the encoder holds DA asserted until the code is
   * read, so a level-triggered flag would re-arm itself the instant the handler
   * cleared it and the monitor would see one keystroke as many.
   */
  private lastCA1: boolean = false
  private lastCA2: boolean = false
  private lastCB1: boolean = false
  private lastCB2: boolean = false

  /** Cycles left of a CA2/CB2 pulse-output strobe, or 0 when idle. */
  private ca2PulseCycles: number = 0
  private cb2PulseCycles: number = 0

  // Attachments
  private portA_attachments: (Attachment | null)[] = []
  private portB_attachments: (Attachment | null)[] = []
  private portA_attachmentCount: number = 0
  private portB_attachmentCount: number = 0

  constructor() {
    this.reset(true)
  }

  reset(coldStart: boolean): void {
    // RES clears every register on a 65C21: both ports become inputs, both
    // control registers zero, so DDRx is what a write to PORTx lands on until
    // the firmware says otherwise. LcdInit depends on exactly that.
    this.regORA = 0x00
    this.regDDRA = 0x00
    this.regCRA = 0x00
    this.regORB = 0x00
    this.regDDRB = 0x00
    this.regCRB = 0x00

    this.CA1 = false
    this.CA2 = false
    this.CB1 = false
    this.CB2 = false

    this.lastCA1 = false
    this.lastCA2 = false
    this.lastCB1 = false
    this.lastCB2 = false

    this.ca2PulseCycles = 0
    this.cb2PulseCycles = 0

    // Reset all attachments (keep registrations — they represent physical wiring)
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      if (this.portA_attachments[i] !== null) {
        this.portA_attachments[i]!.reset()
      }
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      if (this.portB_attachments[i] !== null) {
        this.portB_attachments[i]!.reset()
      }
    }

    // Re-notify attachments of current (reset) control line states
    this.notifyAttachmentsControlLines()
  }

  read(address: number): number {
    const reg = address & 0x03

    switch (reg) {
      case PIA.PIA_PORTA:
        if (this.regCRA & PIA.CR_PORT_SELECT) {
          // The value first, the flags after: reading PORTA is how the KC
          // Monitor's KeyIrq collects the keycode, and clearing the encoder's
          // latch before sampling it would hand the handler an empty port.
          const value = this.readPortA()
          this.regCRA &= ~PIA.CR_FLAGS
          for (let i = 0; i < this.portA_attachmentCount; i++) {
            this.portA_attachments[i]?.clearInterrupts(true, true, false, false)
          }
          this.handshakeAcknowledge(true)
          return value
        }
        return this.regDDRA

      case PIA.PIA_CRA:
        return this.regCRA

      case PIA.PIA_PORTB:
        if (this.regCRB & PIA.CR_PORT_SELECT) {
          const value = this.readPortB()
          this.regCRB &= ~PIA.CR_FLAGS
          for (let i = 0; i < this.portB_attachmentCount; i++) {
            this.portB_attachments[i]?.clearInterrupts(false, false, true, true)
          }
          this.handshakeAcknowledge(false)
          return value
        }
        return this.regDDRB

      case PIA.PIA_CRB:
        return this.regCRB
    }

    return 0x00
  }

  write(address: number, data: number): void {
    const reg = address & 0x03
    const value = data & 0xFF

    switch (reg) {
      case PIA.PIA_PORTA:
        if (this.regCRA & PIA.CR_PORT_SELECT) {
          this.regORA = value
          this.writePortA(value)
        } else {
          this.regDDRA = value
        }
        return

      case PIA.PIA_CRA:
        // Bits 6 and 7 are the chip's own flags and ignore the write.
        this.regCRA = (this.regCRA & PIA.CR_FLAGS) | (value & ~PIA.CR_FLAGS & 0xFF)
        this.updateC2(true)
        return

      case PIA.PIA_PORTB:
        if (this.regCRB & PIA.CR_PORT_SELECT) {
          this.regORB = value
          this.writePortB(value)
        } else {
          this.regDDRB = value
        }
        return

      case PIA.PIA_CRB:
        this.regCRB = (this.regCRB & PIA.CR_FLAGS) | (value & ~PIA.CR_FLAGS & 0xFF)
        this.updateC2(false)
        return
    }
  }

  tick(frequency: number): number {
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      this.portA_attachments[i]?.tick(frequency)
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      this.portB_attachments[i]?.tick(frequency)
    }

    this.sampleInterruptInputs()
    this.advancePulses()

    return this.irqAsserted() ? 0x80 : 0x00
  }

  /**
   * Sample CA1/CA2/CB1/CB2 and latch a flag on the programmed edge.
   *
   * A peripheral raising its interrupt line is what `hasC*Interrupt()` reports;
   * this turns that level into the transition the 65C21 actually latches on.
   */
  private sampleInterruptInputs(): void {
    let ca1 = false
    let ca2 = false
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      const attachment = this.portA_attachments[i]
      if (attachment === null || attachment === undefined) continue
      if (attachment.hasCA1Interrupt()) ca1 = true
      if (attachment.hasCA2Interrupt()) ca2 = true
    }

    let cb1 = false
    let cb2 = false
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      const attachment = this.portB_attachments[i]
      if (attachment === null || attachment === undefined) continue
      if (attachment.hasCB1Interrupt()) cb1 = true
      if (attachment.hasCB2Interrupt()) cb2 = true
    }

    if (this.edged(ca1, this.lastCA1, this.regCRA & PIA.CR_IRQ1_POSITIVE)) {
      this.regCRA |= PIA.CR_IRQ1_FLAG
      // Handshake output mode: CA2 goes low on the read and back high here.
      if (this.c2IsHandshake(true)) this.setCA2(true)
    }
    if (this.edged(cb1, this.lastCB1, this.regCRB & PIA.CR_IRQ1_POSITIVE)) {
      this.regCRB |= PIA.CR_IRQ1_FLAG
      if (this.c2IsHandshake(false)) this.setCB2(true)
    }

    // C2 only latches a flag while it is an input; as an output it is ours.
    if (!(this.regCRA & PIA.CR_C2_OUTPUT) &&
        this.edged(ca2, this.lastCA2, this.regCRA & PIA.CR_IRQ2_POSITIVE)) {
      this.regCRA |= PIA.CR_IRQ2_FLAG
    }
    if (!(this.regCRB & PIA.CR_C2_OUTPUT) &&
        this.edged(cb2, this.lastCB2, this.regCRB & PIA.CR_IRQ2_POSITIVE)) {
      this.regCRB |= PIA.CR_IRQ2_FLAG
    }

    this.lastCA1 = ca1
    this.lastCA2 = ca2
    this.lastCB1 = cb1
    this.lastCB2 = cb2

    // CA1/CB1 are inputs only, so the line the attachments see is the line the
    // peripherals are driving. CA2/CB2 as inputs likewise; as outputs they are
    // left alone here and driven from updateC2().
    let changed = this.CA1 !== ca1 || this.CB1 !== cb1
    this.CA1 = ca1
    this.CB1 = cb1
    if (!(this.regCRA & PIA.CR_C2_OUTPUT) && this.CA2 !== ca2) {
      this.CA2 = ca2
      changed = true
    }
    if (!(this.regCRB & PIA.CR_C2_OUTPUT) && this.CB2 !== cb2) {
      this.CB2 = cb2
      changed = true
    }
    // Only on a change: this runs every clock cycle, and telling every
    // peripheral nothing happened a million times a second is not free.
    if (changed) this.notifyAttachmentsControlLines()
  }

  private edged(now: boolean, before: boolean, positive: number): boolean {
    return positive ? (now && !before) : (!now && before)
  }

  /** Pulse output: one cycle low, then back high. */
  private advancePulses(): void {
    if (this.ca2PulseCycles > 0 && --this.ca2PulseCycles === 0) this.setCA2(true)
    if (this.cb2PulseCycles > 0 && --this.cb2PulseCycles === 0) this.setCB2(true)
  }

  /** True when C2 is an output in handshake mode — low on read, high on C1. */
  private c2IsHandshake(portA: boolean): boolean {
    const cr = portA ? this.regCRA : this.regCRB
    return (cr & PIA.CR_C2_OUTPUT) !== 0 &&
           (cr & PIA.CR_C2_MANUAL) === 0 &&
           (cr & PIA.CR_C2_LEVEL) === 0
  }

  /** True when C2 is an output in pulse mode — low for one cycle after a read. */
  private c2IsPulse(portA: boolean): boolean {
    const cr = portA ? this.regCRA : this.regCRB
    return (cr & PIA.CR_C2_OUTPUT) !== 0 &&
           (cr & PIA.CR_C2_MANUAL) === 0 &&
           (cr & PIA.CR_C2_LEVEL) !== 0
  }

  /** A port read drives C2 low in the two automatic output modes. */
  private handshakeAcknowledge(portA: boolean): void {
    if (this.c2IsHandshake(portA)) {
      if (portA) {
        this.setCA2(false)
      } else {
        this.setCB2(false)
      }
    } else if (this.c2IsPulse(portA)) {
      if (portA) {
        this.setCA2(false)
        this.ca2PulseCycles = 1
      } else {
        this.setCB2(false)
        this.cb2PulseCycles = 1
      }
    }
  }

  /**
   * Apply CRA/CRB bits 3-5 to C2.
   *
   * Manual output is the one the KC Monitor uses: `PIA_CRA_KEYPAD` is $37, so
   * bit 5 makes CA2 an output, bit 4 makes it manual, and bit 3 clear holds it
   * low — which is the 74C922's active-low OE asserted, and the only state in
   * which the encoder drives PA0-PA4 at all.
   */
  private updateC2(portA: boolean): void {
    const cr = portA ? this.regCRA : this.regCRB

    if ((cr & PIA.CR_C2_OUTPUT) && (cr & PIA.CR_C2_MANUAL)) {
      const level = (cr & PIA.CR_C2_LEVEL) !== 0
      if (portA) {
        this.setCA2(level)
      } else {
        this.setCB2(level)
      }
      return
    }
    if (cr & PIA.CR_C2_OUTPUT) {
      // Handshake and pulse both idle high, waiting on a port read.
      if (portA) {
        if (this.ca2PulseCycles === 0) this.setCA2(true)
      } else {
        if (this.cb2PulseCycles === 0) this.setCB2(true)
      }
      return
    }

    this.notifyAttachmentsControlLines()
  }

  private setCA2(level: boolean): void {
    this.CA2 = level
    this.notifyAttachmentsControlLines()
  }

  private setCB2(level: boolean): void {
    this.CB2 = level
    this.notifyAttachmentsControlLines()
  }

  /** IRQA/IRQB, wired together onto the CPU's /IRQ as they are on the card. */
  private irqAsserted(): boolean {
    return this.portIRQ(this.regCRA) || this.portIRQ(this.regCRB)
  }

  private portIRQ(cr: number): boolean {
    if ((cr & PIA.CR_IRQ1_FLAG) && (cr & PIA.CR_IRQ1_ENABLE)) return true
    // A C2 flag only reaches the IRQ line while C2 is an input.
    if (!(cr & PIA.CR_C2_OUTPUT) && (cr & PIA.CR_IRQ2_FLAG) && (cr & PIA.CR_IRQ2_ENABLE)) return true
    return false
  }

  private readPortA(): number {
    let externalInput = 0xFF

    for (let i = 0; i < this.portA_attachmentCount; i++) {
      const attachment = this.portA_attachments[i]
      if (attachment !== null && attachment !== undefined && attachment.isEnabled()) {
        externalInput &= attachment.readPortA(this.regDDRA, this.regORA)
      }
    }

    // Output bits come from the output register, input bits from the pins.
    return ((this.regORA & this.regDDRA) | (externalInput & ~this.regDDRA)) & 0xFF
  }

  private readPortB(): number {
    let externalInput = 0xFF

    for (let i = 0; i < this.portB_attachmentCount; i++) {
      const attachment = this.portB_attachments[i]
      if (attachment !== null && attachment !== undefined && attachment.isEnabled()) {
        externalInput &= attachment.readPortB(this.regDDRB, this.regORB)
      }
    }

    return ((this.regORB & this.regDDRB) | (externalInput & ~this.regDDRB)) & 0xFF
  }

  private writePortA(value: number): void {
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      this.portA_attachments[i]?.writePortA(value, this.regDDRA)
    }
  }

  private writePortB(value: number): void {
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      this.portB_attachments[i]?.writePortB(value, this.regDDRB)
    }
  }

  private notifyAttachmentsControlLines(): void {
    for (let i = 0; i < this.portA_attachmentCount; i++) {
      this.portA_attachments[i]?.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      this.portB_attachments[i]?.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
  }

  private sortAttachmentsByPriority(): void {
    const byPriority = (a: Attachment | null, b: Attachment | null): number =>
      (a?.getPriority() ?? 0) - (b?.getPriority() ?? 0)

    const portA = this.portA_attachments.slice(0, this.portA_attachmentCount).sort(byPriority)
    const portB = this.portB_attachments.slice(0, this.portB_attachmentCount).sort(byPriority)

    for (let i = 0; i < this.portA_attachmentCount; i++) this.portA_attachments[i] = portA[i]
    for (let i = 0; i < this.portB_attachmentCount; i++) this.portB_attachments[i] = portB[i]
  }

  /**
   * Attach a peripheral to Port A
   * @param attachment - The attachment to add
   */
  attachToPortA(attachment: Attachment): void {
    if (attachment !== null && this.portA_attachmentCount < PIA.MAX_ATTACHMENTS_PER_PORT) {
      this.portA_attachments[this.portA_attachmentCount++] = attachment
      this.sortAttachmentsByPriority()
      attachment.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
  }

  /**
   * Attach a peripheral to Port B
   * @param attachment - The attachment to add
   */
  attachToPortB(attachment: Attachment): void {
    if (attachment !== null && this.portB_attachmentCount < PIA.MAX_ATTACHMENTS_PER_PORT) {
      this.portB_attachments[this.portB_attachmentCount++] = attachment
      this.sortAttachmentsByPriority()
      attachment.updateControlLines(this.CA1, this.CA2, this.CB1, this.CB2)
    }
  }

  /**
   * Get a Port A attachment by index
   * @param index - The attachment index
   * @returns The attachment or null if not found
   */
  getPortAAttachment(index: number): Attachment | null {
    if (index < this.portA_attachmentCount) {
      return this.portA_attachments[index]
    }
    return null
  }

  /**
   * Get a Port B attachment by index
   * @param index - The attachment index
   * @returns The attachment or null if not found
   */
  getPortBAttachment(index: number): Attachment | null {
    if (index < this.portB_attachmentCount) {
      return this.portB_attachments[index]
    }
    return null
  }

  //
  // Snapshots
  //

  /**
   * Registers, control lines and every attached peripheral.
   *
   * The attachments are stored per port, and a peripheral wired to both ports —
   * the LCD is, its control lines on A and its data bus on B — therefore appears
   * twice. That is harmless (applying a state twice lands on the same result)
   * and it is the honest encoding of what the board looks like.
   *
   * Registrations are not serialized. They are physical wiring, restored by
   * constructing the machine, which is why reset() keeps them too.
   */
  serialize(): DeviceState {
    return {
      kind: this.kind,
      regORA: this.regORA,
      regDDRA: this.regDDRA,
      regCRA: this.regCRA,
      regORB: this.regORB,
      regDDRB: this.regDDRB,
      regCRB: this.regCRB,
      CA1: this.CA1,
      CA2: this.CA2,
      CB1: this.CB1,
      CB2: this.CB2,
      lastCA1: this.lastCA1,
      lastCA2: this.lastCA2,
      lastCB1: this.lastCB1,
      lastCB2: this.lastCB2,
      ca2PulseCycles: this.ca2PulseCycles,
      cb2PulseCycles: this.cb2PulseCycles,
      portA: this.portA_attachments
        .slice(0, this.portA_attachmentCount)
        .map((attachment) => attachment!.serialize()),
      portB: this.portB_attachments
        .slice(0, this.portB_attachmentCount)
        .map((attachment) => attachment!.serialize())
    }
  }

  deserialize(state: DeviceState): void {
    expectKind(state, this.kind)

    this.regORA = readNumber(state, 'regORA')
    this.regDDRA = readNumber(state, 'regDDRA')
    this.regCRA = readNumber(state, 'regCRA')
    this.regORB = readNumber(state, 'regORB')
    this.regDDRB = readNumber(state, 'regDDRB')
    this.regCRB = readNumber(state, 'regCRB')
    this.CA1 = readBoolean(state, 'CA1')
    this.CA2 = readBoolean(state, 'CA2')
    this.CB1 = readBoolean(state, 'CB1')
    this.CB2 = readBoolean(state, 'CB2')
    this.lastCA1 = readBoolean(state, 'lastCA1')
    this.lastCA2 = readBoolean(state, 'lastCA2')
    this.lastCB1 = readBoolean(state, 'lastCB1')
    this.lastCB2 = readBoolean(state, 'lastCB2')
    this.ca2PulseCycles = readNumber(state, 'ca2PulseCycles')
    this.cb2PulseCycles = readNumber(state, 'cb2PulseCycles')

    // The counts have to agree exactly. A snapshot with more peripherals than
    // this PIA has came from a differently wired card, and applying only the
    // ones that line up would leave the rest holding another machine's state —
    // so readStates refuses the whole thing.
    const portA = readStates(state, 'portA', this.portA_attachmentCount)
    const portB = readStates(state, 'portB', this.portB_attachmentCount)

    for (let i = 0; i < this.portA_attachmentCount; i++) {
      this.portA_attachments[i]!.deserialize(portA[i]!)
    }
    for (let i = 0; i < this.portB_attachmentCount; i++) {
      this.portB_attachments[i]!.deserialize(portB[i]!)
    }

    this.notifyAttachmentsControlLines()
  }
}
