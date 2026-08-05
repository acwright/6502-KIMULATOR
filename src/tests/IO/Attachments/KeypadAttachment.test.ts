/**
 * Ported from 6502-EMULATOR@d8b7882, and extended.
 *
 * What changed is the input: that version took a USB HID usage ID and looked it
 * up in a table it owned. The table now lives in KeypadMap, shared with the UI
 * and the CLI, and the encoder takes the 5-bit code it would actually put on
 * PA0–PA4. So the mapping cases below press codes rather than HID IDs, and the
 * "is this key on the pad" question moved with the table — see KeypadMap.test.ts.
 *
 * What did not change is the behaviour under test, which is the point: OE gates
 * the bus, DA is independent of OE, releases are ignored, and a read through
 * clearInterrupts empties the latch.
 */
import { KeypadAttachment } from '../../../core/IO/Attachments/KeypadAttachment'
import { KEYPAD } from '../../../core/KeypadMap'

describe('KeypadAttachment', () => {
  let keypadA: KeypadAttachment   // attached to Port A
  let keypadB: KeypadAttachment   // attached to Port B

  beforeEach(() => {
    keypadA = new KeypadAttachment(true, 0)
    keypadB = new KeypadAttachment(false, 0)
  })

  // ---------------------------------------------------------------------------
  describe('Initialization', () => {
    it('should have no data ready after construction', () => {
      expect(keypadA.hasDataReady()).toBe(false)
      expect(keypadB.hasDataReady()).toBe(false)
    })

    it('should have no interrupt pending after construction', () => {
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.hasCB1Interrupt()).toBe(false)
      expect(keypadB.hasCA1Interrupt()).toBe(false)
      expect(keypadB.hasCB1Interrupt()).toBe(false)
    })

    it('should return 0xFF on port reads when idle (Port A)', () => {
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('should return 0xFF on port reads when idle (Port B)', () => {
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('should be enabled by default', () => {
      expect(keypadA.isEnabled()).toBe(true)
    })

    it('should report the correct priority', () => {
      const kp = new KeypadAttachment(true, 7)
      expect(kp.getPriority()).toBe(7)
    })

    it('getCurrentKey should return 0xFF when no data is ready', () => {
      expect(keypadA.getCurrentKey()).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Reset', () => {
    it('should clear data ready, interrupt, and keypad value', () => {
      keypadA.press(0x01)  // press '1'
      expect(keypadA.hasDataReady()).toBe(true)

      keypadA.reset()

      expect(keypadA.hasDataReady()).toBe(false)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.getCurrentKey()).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Key press → port value', () => {
    // Helpers: assert OE (CA2/CB2 LOW) then press and read
    const pressAndReadA = (kp: KeypadAttachment, code: number) => {
      kp.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted for Port A
      kp.press(code)
      return kp.readPortA(0x00, 0x00)
    }
    const pressAndReadB = (kp: KeypadAttachment, code: number) => {
      kp.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted for Port B
      kp.press(code)
      return kp.readPortB(0x00, 0x00)
    }

    it.each(KEYPAD.map((key) => [key.label, key.code] as const))(
      'key %s appears on PA0–PA4 as $%s',
      (_label, code) => {
        expect(pressAndReadA(new KeypadAttachment(true), code)).toBe(code)
      }
    )

    it('should also map correctly on Port B', () => {
      expect(pressAndReadB(new KeypadAttachment(false), 0x01)).toBe(0x01)  // '1'
      expect(pressAndReadB(new KeypadAttachment(false), 0x17)).toBe(0x17)  // 'B'
    })
  })

  // ---------------------------------------------------------------------------
  describe('Bits 5–7 are always 0 when data is present', () => {
    it('should mask bits 5–7 to 0 on Port A reads', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.press(0x17)  // 'B' = 0b10111 – the highest valid code
      const value = keypadA.readPortA(0x00, 0x00)
      expect(value & 0xE0).toBe(0x00)  // bits 5, 6, 7 must be 0
    })

    it('should mask bits 5–7 to 0 on Port B reads', () => {
      keypadB.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted
      keypadB.press(0x17)
      const value = keypadB.readPortB(0x00, 0x00)
      expect(value & 0xE0).toBe(0x00)
    })

    it('getCurrentKey should never have bits 5–7 set', () => {
      keypadA.press(0x10)  // ESC; bit 4 set
      expect(keypadA.getCurrentKey() & 0xE0).toBe(0x00)  // getCurrentKey is independent of OE
    })
  })

  // ---------------------------------------------------------------------------
  describe('Port attachment routing', () => {
    it('Port A attachment should not drive Port B', () => {
      keypadA.press(0x01)  // press '1'
      expect(keypadA.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('Port B attachment should not drive Port A', () => {
      keypadB.press(0x01)  // press '1'
      expect(keypadB.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Interrupt behaviour (Port A)', () => {
    it('should assert CA1 after a key press', () => {
      keypadA.press(0x01)
      expect(keypadA.hasCA1Interrupt()).toBe(true)
    })

    it('should not assert CB1 when attached to Port A', () => {
      keypadA.press(0x01)
      expect(keypadA.hasCB1Interrupt()).toBe(false)
    })

    it('clearInterrupts(ca1) should deassert CA1 and clear data ready', () => {
      keypadA.press(0x01)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
      expect(keypadA.hasDataReady()).toBe(false)
    })

    it('clearInterrupts(cb1) should not affect CA1 keypad', () => {
      keypadA.press(0x01)
      keypadA.clearInterrupts(false, false, true, false)  // wrong line
      expect(keypadA.hasCA1Interrupt()).toBe(true)
      expect(keypadA.hasDataReady()).toBe(true)
    })

    it('port reads after clearInterrupts should return 0xFF', () => {
      keypadA.press(0x01)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Interrupt behaviour (Port B)', () => {
    it('should assert CB1 after a key press', () => {
      keypadB.press(0x01)
      expect(keypadB.hasCB1Interrupt()).toBe(true)
    })

    it('should not assert CA1 when attached to Port B', () => {
      keypadB.press(0x01)
      expect(keypadB.hasCA1Interrupt()).toBe(false)
    })

    it('clearInterrupts(cb1) should deassert CB1 and clear data ready', () => {
      keypadB.press(0x01)
      keypadB.clearInterrupts(false, false, true, false)
      expect(keypadB.hasCB1Interrupt()).toBe(false)
      expect(keypadB.hasDataReady()).toBe(false)
    })

    it('clearInterrupts(ca1) should not affect CB1 keypad', () => {
      keypadB.press(0x01)
      keypadB.clearInterrupts(true, false, false, false)  // wrong line
      expect(keypadB.hasCB1Interrupt()).toBe(true)
      expect(keypadB.hasDataReady()).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  /**
   * The 74C922 has no release to report — it strobes DA on a press and says
   * nothing when the key comes back up. There is deliberately no `release()` to
   * call here: a release the hardware never sends is one the emulator must not
   * invent, and the KC Monitor holding a key down without it repeating is that
   * decision showing through.
   */
  describe('Key releases', () => {
    it('has no way to report one', () => {
      expect((keypadA as unknown as Record<string, unknown>).release).toBeUndefined()
    })

    it('leaves the latch empty once the code has been read', () => {
      keypadA.press(0x01)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Codes that are not on this pad', () => {
    it.each([24, 25, 31, 32, 255, -1, 0.5, NaN])(
      'should not latch $%s',
      (code) => {
        keypadA.press(code)
        expect(keypadA.hasDataReady()).toBe(false)
        expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
      }
    )

    it('should not fire an interrupt for a code no switch produces', () => {
      keypadA.press(0x18)
      expect(keypadA.hasCA1Interrupt()).toBe(false)
    })

    it('accepts every code the encoder can actually produce', () => {
      for (let code = 0; code < KeypadAttachment.KEY_COUNT; code++) {
        const kp = new KeypadAttachment(true)
        kp.press(code)
        expect(kp.hasDataReady()).toBe(true)
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe('Successive key presses', () => {
    it('should latch the latest key code when a second key is pressed', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.press(0x01)  // '1'
      keypadA.clearInterrupts(true, false, false, false)

      keypadA.press(0x02)  // '2'
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x02)
      expect(keypadA.hasCA1Interrupt()).toBe(true)
    })

    /**
     * A press the monitor has not collected yet is overwritten, not queued. The
     * encoder is one latch deep, and hiding that behind a buffer would let the
     * emulator absorb a burst of keys the real pad would drop.
     */
    it('overwrites an uncollected press rather than queueing it', () => {
      keypadA.updateControlLines(false, false, false, true)
      keypadA.press(0x01)
      keypadA.press(0x02)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x02)
      keypadA.clearInterrupts(true, false, false, false)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('OE (Output Enable) via CA2/CB2', () => {
    it('Port A: data is not driven when CA2 is HIGH (OE disabled)', () => {
      keypadA.updateControlLines(false, true, false, true)  // CA2 HIGH → OE deasserted
      keypadA.press(0x01)  // '1'
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('Port A: data IS driven when CA2 is LOW (OE enabled)', () => {
      keypadA.updateControlLines(false, false, false, true)  // CA2 LOW → OE asserted
      keypadA.press(0x01)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x01)
    })

    it('Port B: data is not driven when CB2 is HIGH (OE disabled)', () => {
      keypadB.updateControlLines(false, true, false, true)  // CB2 HIGH → OE deasserted
      keypadB.press(0x01)
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0xFF)
    })

    it('Port B: data IS driven when CB2 is LOW (OE enabled)', () => {
      keypadB.updateControlLines(false, true, false, false)  // CB2 LOW → OE asserted
      keypadB.press(0x01)
      expect(keypadB.readPortB(0x00, 0x00)).toBe(0x01)
    })

    it('CA1 interrupt fires regardless of OE state', () => {
      keypadA.updateControlLines(false, true, false, true)  // OE disabled
      keypadA.press(0x01)
      expect(keypadA.hasCA1Interrupt()).toBe(true)  // DA line is independent of OE
    })

    it('CB1 interrupt fires regardless of OE state', () => {
      keypadB.updateControlLines(false, true, false, true)  // OE disabled
      keypadB.press(0x01)
      expect(keypadB.hasCB1Interrupt()).toBe(true)
    })

    it('toggling OE HIGH then LOW reveals the latched value', () => {
      keypadA.press(0x03)  // '3'
      // OE still disabled – bus should be high-Z
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
      // Now the PIA asserts CA2 LOW to enable OE
      keypadA.updateControlLines(false, false, false, true)
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0x03)
    })

    it('reset clears OE state to disabled', () => {
      keypadA.updateControlLines(false, false, false, true)  // OE asserted
      keypadA.press(0x01)
      keypadA.reset()
      // After reset OE should be HIGH (disabled) and dataReady cleared
      expect(keypadA.readPortA(0x00, 0x00)).toBe(0xFF)
    })
  })

  // ---------------------------------------------------------------------------
  describe('Snapshots', () => {
    it('names itself so it cannot be applied to another peripheral', () => {
      expect(keypadA.serialize().kind).toBe('keypad')
      expect(() => keypadA.deserialize({ kind: 'lcd' })).toThrow(/expected keypad state/)
    })

    /**
     * A snapshot taken between the press and KeyIrq's read is holding a
     * keystroke. Dropping it loses the key, and losing a key on a machine whose
     * only input is a keypad is not a small bug.
     */
    it('carries an uncollected keystroke across a round trip', () => {
      keypadA.updateControlLines(false, false, false, true)  // OE asserted
      keypadA.press(0x0F)  // 'C'

      const after = new KeypadAttachment(true, 0)
      after.deserialize(JSON.parse(JSON.stringify(keypadA.serialize())))

      expect(after.hasDataReady()).toBe(true)
      expect(after.hasCA1Interrupt()).toBe(true)
      expect(after.readPortA(0x00, 0x00)).toBe(0x0F)
    })

    it('carries the OE level, so the restored pad is not driving a bus it should not', () => {
      keypadA.updateControlLines(false, true, false, true)  // OE deasserted
      keypadA.press(0x0F)

      const after = new KeypadAttachment(true, 0)
      after.deserialize(JSON.parse(JSON.stringify(keypadA.serialize())))

      expect(after.readPortA(0x00, 0x00)).toBe(0xFF)
    })

    it('refuses a state missing a field', () => {
      const state = keypadA.serialize()
      delete state.dataReady
      expect(() => new KeypadAttachment(true).deserialize(state)).toThrow(/expected true or false/)
    })
  })
})
