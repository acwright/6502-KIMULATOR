import { PIA } from '../../core/IO/PIA'
import { AttachmentBase } from '../../core/IO/Attachments/Attachment'
import { KeypadAttachment } from '../../core/IO/Attachments/KeypadAttachment'
import { LCDAttachment } from '../../core/IO/Attachments/LCDAttachment'

// Register offsets — RS1:RS0 are A1:A0
const PORTA = 0x00
const CRA   = 0x01
const PORTB = 0x02
const CRB   = 0x03

// Control register bits
const CR_DDR    = 0x00  // access DDRx
const CR_PORT   = 0x04  // access PORTx data register
const CR_IRQ1_ENABLE = 0x01
const CR_IRQ1_POSITIVE = 0x02

/** $37 — the value KC Monitor's PiaInit writes: CA2 out low, CA1 +edge, IRQ on, PORT. */
const PIA_CRA_KEYPAD = 0x37

/** A peripheral that reports whatever the test tells it to. */
class Probe extends AttachmentBase {
  protected readonly kind = 'probe'

  portA = 0xFF
  portB = 0xFF
  writesA: number[] = []
  writesB: number[] = []
  lines: [boolean, boolean, boolean, boolean] = [false, false, false, false]
  ticks = 0

  constructor(priority = 0) {
    super(priority)
  }

  override readPortA(): number { return this.portA }
  override readPortB(): number { return this.portB }
  override writePortA(value: number): void { this.writesA.push(value) }
  override writePortB(value: number): void { this.writesB.push(value) }
  override tick(): void { this.ticks++ }

  override updateControlLines(ca1: boolean, ca2: boolean, cb1: boolean, cb2: boolean): void {
    this.lines = [ca1, ca2, cb1, cb2]
  }

  /** Raise or drop this peripheral's interrupt lines directly. */
  set(ca1: boolean, ca2 = false, cb1 = false, cb2 = false): void {
    this.ca1Interrupt = ca1
    this.ca2Interrupt = ca2
    this.cb1Interrupt = cb1
    this.cb2Interrupt = cb2
  }
}

describe('PIA', () => {
  let pia: PIA

  beforeEach(() => {
    pia = new PIA()
  })

  //
  // Reset
  //

  describe('reset', () => {
    /**
     * RES clears everything, so both ports come up as inputs and both control
     * registers as zero. LcdInit depends on exactly that: its first write to
     * PORTA has to land on DDRA, which it only does while CRA bit 2 is clear.
     */
    it('leaves both ports as inputs with the DDR selected', () => {
      expect(pia.read(CRA)).toBe(0x00)
      expect(pia.read(CRB)).toBe(0x00)
      expect(pia.read(PORTA)).toBe(0x00)  // DDRA
      expect(pia.read(PORTB)).toBe(0x00)  // DDRB
    })

    it('asserts no interrupt', () => {
      expect(pia.tick(1000000)).toBe(0x00)
    })

    it('clears the registers a running machine had set', () => {
      pia.write(CRA, CR_PORT)
      pia.write(PORTA, 0xAA)
      pia.write(CRB, PIA_CRA_KEYPAD)

      pia.reset(true)

      expect(pia.read(CRA)).toBe(0x00)
      expect(pia.read(CRB)).toBe(0x00)
    })

    it('resets its peripherals but keeps them wired', () => {
      const probe = new Probe()
      pia.attachToPortA(probe)
      probe.set(true)

      pia.reset(false)

      expect(probe.hasCA1Interrupt()).toBe(false)
      expect(pia.getPortAAttachment(0)).toBe(probe)
    })
  })

  //
  // Register decode
  //

  describe('register select', () => {
    it('reads CRA and CRB back', () => {
      pia.write(CRA, 0x24)
      pia.write(CRB, 0x14)
      expect(pia.read(CRA)).toBe(0x24)
      expect(pia.read(CRB)).toBe(0x14)
    })

    it('sends a PORTA access to DDRA while CRA bit 2 is clear', () => {
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xE0)
      expect(pia.read(PORTA)).toBe(0xE0)  // reads DDRA back
    })

    it('sends a PORTA access to the data register once CRA bit 2 is set', () => {
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xFF)   // DDRA — all outputs
      pia.write(CRA, CR_PORT)
      pia.write(PORTA, 0x5A)
      expect(pia.read(PORTA)).toBe(0x5A)
    })

    it('keeps the two ports independent', () => {
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xE0)
      pia.write(CRB, CR_DDR)
      pia.write(PORTB, 0xFF)

      expect(pia.read(PORTA)).toBe(0xE0)
      expect(pia.read(PORTB)).toBe(0xFF)
    })

    /**
     * The register select is A1:A0, so the four registers repeat all the way up
     * the window. The machine hands over `address & 3`, and this is the same
     * check one level down.
     */
    it('decodes only the low two address bits', () => {
      pia.write(CRA, 0x24)
      expect(pia.read(CRA + 0x04)).toBe(0x24)
      expect(pia.read(CRA + 0xFC)).toBe(0x24)
    })

    it('ignores writes to the read-only flag bits of a control register', () => {
      pia.write(CRA, 0xFF)
      expect(pia.read(CRA) & 0xC0).toBe(0x00)
      expect(pia.read(CRA) & 0x3F).toBe(0x3F)
    })
  })

  //
  // Ports
  //

  describe('ports', () => {
    let probe: Probe

    beforeEach(() => {
      probe = new Probe()
      pia.attachToPortA(probe)
      pia.attachToPortB(probe)
    })

    it('reads output bits from the output register and input bits from the pins', () => {
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xF0)   // high nibble out, low nibble in
      pia.write(CRA, CR_PORT)
      pia.write(PORTA, 0xA5)   // drives $A0 on the outputs
      probe.portA = 0x0C       // the peripheral drives the low nibble

      expect(pia.read(PORTA)).toBe(0xAC)
    })

    it('floats an undriven input high', () => {
      pia.write(CRA, CR_PORT)  // DDRA still 0 — all inputs
      expect(pia.read(PORTA)).toBe(0xFF)
    })

    it('ANDs peripherals that share a port, as open-drain wiring does', () => {
      const second = new Probe(1)
      pia.attachToPortA(second)
      probe.portA = 0xF0
      second.portA = 0x3C
      pia.write(CRA, CR_PORT)

      expect(pia.read(PORTA)).toBe(0x30)
    })

    it('does not consult a disabled peripheral', () => {
      probe.portA = 0x00
      probe['enabled'] = false
      pia.write(CRA, CR_PORT)
      expect(pia.read(PORTA)).toBe(0xFF)
    })

    it('passes a data-register write out to the peripherals', () => {
      pia.write(CRB, CR_DDR)
      pia.write(PORTB, 0xFF)
      pia.write(CRB, CR_PORT)
      pia.write(PORTB, 0x42)

      expect(probe.writesB).toEqual([0x42])
    })

    it('does not pass a DDR write out as port data', () => {
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xE0)
      expect(probe.writesA).toEqual([])
    })

    it('ticks every peripheral once per clock cycle', () => {
      pia.tick(1000000)
      pia.tick(1000000)
      // Wired to both ports, so it is ticked once for each — the honest encoding
      // of a chip that answers on two of them.
      expect(probe.ticks).toBe(4)
    })
  })

  //
  // Interrupts
  //

  describe('C1 interrupts', () => {
    let probe: Probe

    beforeEach(() => {
      probe = new Probe()
      pia.attachToPortA(probe)
    })

    it('latches CRA bit 7 on a rising edge when CRA bit 1 selects one', () => {
      pia.write(CRA, CR_PORT | CR_IRQ1_POSITIVE)
      probe.set(true)
      pia.tick(1000000)

      expect(pia.read(CRA) & 0x80).toBe(0x80)
    })

    it('ignores a rising edge when CRA bit 1 selects the falling one', () => {
      pia.write(CRA, CR_PORT)  // bit 1 clear — negative edge
      probe.set(true)
      pia.tick(1000000)
      expect(pia.read(CRA) & 0x80).toBe(0x00)

      probe.set(false)
      pia.tick(1000000)
      expect(pia.read(CRA) & 0x80).toBe(0x80)
    })

    /**
     * The difference from the 6522 that matters on this card. The encoder holds
     * DA asserted until the code is read, so a level-triggered flag would re-arm
     * itself the instant the handler cleared it and one keystroke would look
     * like a stream of them.
     */
    it('latches once per edge, not once per cycle the line is held', () => {
      pia.write(CRA, CR_PORT | CR_IRQ1_POSITIVE)
      probe.set(true)
      pia.tick(1000000)
      pia.read(PORTA)                         // the handler's read clears the flag
      probe.set(true)                         // and the line is still high

      for (let i = 0; i < 100; i++) pia.tick(1000000)
      expect(pia.read(CRA) & 0x80).toBe(0x00)
    })

    it('asserts IRQ only while the flag is set and enabled', () => {
      pia.write(CRA, CR_PORT | CR_IRQ1_POSITIVE)  // bit 0 clear — IRQ masked
      probe.set(true)
      expect(pia.tick(1000000)).toBe(0x00)

      pia.write(CRA, CR_PORT | CR_IRQ1_POSITIVE | CR_IRQ1_ENABLE)
      expect(pia.tick(1000000)).toBe(0x80)
    })

    it('drops IRQ when the port is read', () => {
      pia.write(CRA, PIA_CRA_KEYPAD)
      probe.set(true)
      expect(pia.tick(1000000)).toBe(0x80)

      pia.read(PORTA)

      expect(pia.tick(1000000)).toBe(0x00)
      expect(pia.read(CRA) & 0x80).toBe(0x00)
    })

    it('tells the peripheral its interrupt was serviced', () => {
      const cleared = jest.spyOn(probe, 'clearInterrupts')
      pia.write(CRA, CR_PORT)
      pia.read(PORTA)
      expect(cleared).toHaveBeenCalledWith(true, true, false, false)
    })

    it('does not clear the flags on a DDR read', () => {
      pia.write(CRA, CR_PORT | CR_IRQ1_POSITIVE | CR_IRQ1_ENABLE)
      probe.set(true)
      pia.tick(1000000)
      pia.write(CRA, CR_DDR | CR_IRQ1_POSITIVE | CR_IRQ1_ENABLE)

      pia.read(PORTA)  // DDRA

      expect(pia.read(CRA) & 0x80).toBe(0x80)
    })

    it('runs the same way on Port B through CRB', () => {
      const onB = new Probe()
      pia.attachToPortB(onB)
      pia.write(CRB, CR_PORT | CR_IRQ1_POSITIVE | CR_IRQ1_ENABLE)
      onB.set(false, false, true)

      expect(pia.tick(1000000)).toBe(0x80)
      pia.read(PORTB)
      expect(pia.tick(1000000)).toBe(0x00)
    })
  })

  describe('C2 as an interrupt input', () => {
    let probe: Probe

    beforeEach(() => {
      probe = new Probe()
      pia.attachToPortA(probe)
    })

    it('latches CRA bit 6 on the programmed edge', () => {
      pia.write(CRA, CR_PORT | 0x10)  // C2 input, positive edge
      probe.set(false, true)
      pia.tick(1000000)
      expect(pia.read(CRA) & 0x40).toBe(0x40)
    })

    it('asserts IRQ when CRA bit 3 enables it', () => {
      pia.write(CRA, CR_PORT | 0x10 | 0x08)
      probe.set(false, true)
      expect(pia.tick(1000000)).toBe(0x80)
    })

    /**
     * On this card CA2 is an output driving the encoder's OE, and an output
     * cannot interrupt. Bits 3 and 4 mean something else entirely then — the
     * level and the mode — so reading them as an enable would put the machine in
     * a permanent interrupt the moment PiaInit ran.
     */
    it('cannot interrupt while CA2 is an output', () => {
      pia.write(CRA, PIA_CRA_KEYPAD)  // $37 — CA2 output, manual, low
      probe.set(false, true)
      expect(pia.tick(1000000)).toBe(0x00)
      expect(pia.read(CRA) & 0x40).toBe(0x00)
    })
  })

  //
  // CA2 as an output
  //

  describe('C2 as an output', () => {
    let probe: Probe

    beforeEach(() => {
      probe = new Probe()
      pia.attachToPortA(probe)
    })

    it('drives CA2 low from CRA $37, as PiaInit does', () => {
      pia.write(CRA, PIA_CRA_KEYPAD)
      expect(probe.lines[1]).toBe(false)
    })

    it('drives CA2 high when CRA bit 3 is set', () => {
      pia.write(CRA, 0x3F)  // output, manual, level high
      expect(probe.lines[1]).toBe(true)
    })

    it('follows the bit as the firmware toggles it', () => {
      pia.write(CRA, 0x3F)
      expect(probe.lines[1]).toBe(true)
      pia.write(CRA, 0x37)
      expect(probe.lines[1]).toBe(false)
    })

    it('pulses low for one cycle after a port read in pulse mode', () => {
      pia.write(CRA, CR_PORT | 0x20 | 0x08)  // output, automatic, pulse
      expect(probe.lines[1]).toBe(true)

      pia.read(PORTA)
      expect(probe.lines[1]).toBe(false)

      pia.tick(1000000)
      expect(probe.lines[1]).toBe(true)
    })

    it('holds low from a port read until the next C1 edge in handshake mode', () => {
      pia.write(CRA, CR_PORT | 0x20 | CR_IRQ1_POSITIVE)  // output, automatic, handshake
      pia.read(PORTA)
      expect(probe.lines[1]).toBe(false)

      pia.tick(1000000)
      expect(probe.lines[1]).toBe(false)

      probe.set(true)
      pia.tick(1000000)
      expect(probe.lines[1]).toBe(true)
    })

    it('drives CB2 from CRB in the same way', () => {
      const onB = new Probe()
      pia.attachToPortB(onB)
      pia.write(CRB, 0x3F)
      expect(onB.lines[3]).toBe(true)
      pia.write(CRB, 0x37)
      expect(onB.lines[3]).toBe(false)
    })
  })

  //
  // Attachments
  //

  describe('attachments', () => {
    it('hands a peripheral the current control lines as it is wired in', () => {
      pia.write(CRA, PIA_CRA_KEYPAD)  // CA2 already low
      const probe = new Probe()
      pia.attachToPortA(probe)
      expect(probe.lines[1]).toBe(false)
    })

    it('orders them by priority, lowest first', () => {
      const third = new Probe(30)
      const first = new Probe(10)
      const second = new Probe(20)
      pia.attachToPortA(third)
      pia.attachToPortA(first)
      pia.attachToPortA(second)

      expect(pia.getPortAAttachment(0)).toBe(first)
      expect(pia.getPortAAttachment(1)).toBe(second)
      expect(pia.getPortAAttachment(2)).toBe(third)
    })

    it('returns null past the end of a port', () => {
      expect(pia.getPortAAttachment(0)).toBeNull()
      expect(pia.getPortBAttachment(3)).toBeNull()
    })

    it('takes no more than eight per port', () => {
      for (let i = 0; i < 10; i++) pia.attachToPortA(new Probe(i))
      expect(pia.getPortAAttachment(7)).not.toBeNull()
      expect(pia.getPortAAttachment(8)).toBeNull()
    })
  })

  //
  // The card as it is actually wired
  //

  describe('the Keypad Card', () => {
    let keypad: KeypadAttachment
    let lcd: LCDAttachment

    beforeEach(() => {
      keypad = new KeypadAttachment(true, 10)
      lcd = new LCDAttachment(16, 2, 20)
      pia.attachToPortA(keypad)
      pia.attachToPortA(lcd)
      pia.attachToPortB(lcd)

      // PiaInit, transcribed: DDRA $E0, DDRB $FF, CRA $37, then a PORTA read to
      // clear any pending CA1 flag.
      pia.write(CRA, CR_DDR)
      pia.write(PORTA, 0xE0)
      pia.write(CRB, CR_DDR)
      pia.write(PORTB, 0xFF)
      pia.write(CRB, CR_PORT)
      pia.write(CRA, PIA_CRA_KEYPAD)
      pia.read(PORTA)
    })

    it('reads a pressed key back on PA0–PA4', () => {
      keypad.press(0x13)  // 'A'
      expect(pia.read(PORTA) & 0x1F).toBe(0x13)
    })

    it('raises IRQ on the press and drops it on the read', () => {
      keypad.press(0x13)
      expect(pia.tick(1000000)).toBe(0x80)
      expect(pia.read(CRA) & 0x80).toBe(0x80)

      pia.read(PORTA)

      expect(pia.tick(1000000)).toBe(0x00)
    })

    it('reads the LCD control lines back as the firmware left them', () => {
      pia.write(PORTA, 0xA0)  // RS high, E high
      expect(pia.read(PORTA) & 0xE0).toBe(0xA0)
    })

    it('floats PA0–PA4 high with nothing pressed', () => {
      expect(pia.read(PORTA) & 0x1F).toBe(0x1F)
    })

    /**
     * The whole reason CA2 is wired to OE. With the encoder's output disabled
     * the port floats, and the KC Monitor's `and #KEY_MASK` would read $1F —
     * a phantom code above KEY_COUNT that the ISR discards.
     */
    it('floats PA0–PA4 high while CA2 holds OE deasserted', () => {
      pia.write(CRA, 0x3F)  // CA2 high — OE off
      keypad.press(0x13)
      expect(pia.read(PORTA) & 0x1F).toBe(0x1F)
    })

    it('carries a character to the LCD across Port B and the E strobe', () => {
      pia.write(CRA, PIA_CRA_KEYPAD)
      pia.write(PORTB, 0x0C)          // display on
      pia.write(PORTA, 0x80)          // E high, RS low
      pia.write(PORTA, 0x00)          // E falls — command latches

      pia.write(PORTB, 0x4B)          // 'K'
      pia.write(PORTA, 0xA0)          // E high, RS high
      pia.write(PORTA, 0x20)          // E falls — data latches

      expect(lcd.getRowText(0).charAt(0)).toBe('K')
    })
  })

  //
  // Snapshots
  //

  describe('snapshots', () => {
    const wired = (): { pia: PIA, keypad: KeypadAttachment, lcd: LCDAttachment } => {
      const built = new PIA()
      const keypad = new KeypadAttachment(true, 10)
      const lcd = new LCDAttachment(16, 2, 20)
      built.attachToPortA(keypad)
      built.attachToPortA(lcd)
      built.attachToPortB(lcd)
      return { pia: built, keypad, lcd }
    }

    it('names itself', () => {
      expect(pia.serialize().kind).toBe('pia')
      expect(() => pia.deserialize({ kind: 'acia' })).toThrow(/expected pia state/)
    })

    it('is JSON-ready', () => {
      const { pia: from } = wired()
      expect(() => JSON.stringify(from.serialize())).not.toThrow()
    })

    it('carries the registers across a round trip', () => {
      const { pia: from } = wired()
      from.write(CRA, CR_DDR)
      from.write(PORTA, 0xE0)
      from.write(CRB, CR_DDR)
      from.write(PORTB, 0xFF)
      from.write(CRA, PIA_CRA_KEYPAD)
      from.write(CRB, CR_PORT)
      from.write(PORTB, 0x5A)

      const { pia: into } = wired()
      into.deserialize(JSON.parse(JSON.stringify(from.serialize())))

      expect(into.read(CRA)).toBe(from.read(CRA))
      expect(into.read(CRB)).toBe(from.read(CRB))
      expect(into.read(PORTB)).toBe(0x5A)
    })

    it('carries an uncollected keystroke, and the CA2 level that reveals it', () => {
      const { pia: from, keypad } = wired()
      from.write(CRA, PIA_CRA_KEYPAD)  // CA2 low — OE asserted
      keypad.press(0x0F)
      from.tick(1000000)

      const { pia: into } = wired()
      into.deserialize(JSON.parse(JSON.stringify(from.serialize())))

      expect(into.read(CRA) & 0x80).toBe(0x80)
      expect(into.read(PORTA) & 0x1F).toBe(0x0F)
    })

    it('refuses a snapshot from a differently wired card', () => {
      const { pia: from } = wired()
      const bare = new PIA()
      expect(() => bare.deserialize(JSON.parse(JSON.stringify(from.serialize()))))
        .toThrow(/expected 0 entries, got 2/)
    })

    it('refuses a state missing a register', () => {
      const state = pia.serialize()
      delete state.regCRA
      expect(() => new PIA().deserialize(state)).toThrow(/expected a number/)
    })
  })
})
