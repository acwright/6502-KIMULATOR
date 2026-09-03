/**
 * The phase 2 exit criteria, run against the real firmware.
 *
 * Everything else in this directory tests a chip in isolation. This one builds
 * the machine out of the two bundled images and drives it the way a person
 * does — press a key, wait, read the glass — because that is the only thing
 * that proves the PIA, the encoder, the LCD controller and the decode all agree
 * with the KC Monitor's idea of the card.
 *
 * It is deliberately slow. `LcdInit` runs the HD44780 power-on ritual with four
 * ~41 ms software delays in it, so reaching the splash costs about 1.8 million
 * clock cycles, and there is no honest way to skip them: the delays are what the
 * firmware does.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine } from '../core/Machine'
import { Empty } from '../core/IO/Empty'
import type { SlotConfig } from '../core/Machine'
import { keyForName } from '../core/KeypadMap'

const ROOT = join(__dirname, '../..')

/** Where KernalInit records what it found on the bus — BIOS.inc. */
const HW_PRESENT = 0x030d
const HW_SC = 0x10

/** Where the monitor starts, and where user programs live — 6502.inc. */
const PROGRAM_START = 0x0800

const BIOS = readFileSync(join(ROOT, 'assets/roms/BIOS.bin'))
const KC_MONITOR = readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin'))

/** A machine as the KIM is actually built, with both ROMs in it. */
const build = (slots: SlotConfig = {}): Machine => {
  const machine = new Machine(slots)
  machine.loadROM(BIOS)
  machine.loadCardROM(KC_MONITOR)
  machine.resetCPU()
  return machine
}

/** Run until `done()`, or give up. Returns whether it got there. */
const runUntil = (machine: Machine, done: () => boolean, budget = 4_000_000): boolean => {
  for (let spent = 0; spent < budget; spent += 25_000) {
    machine.runCycles(25_000)
    if (done()) return true
  }
  return false
}

/** Press a key by name and let the monitor finish repainting the panel. */
const press = (machine: Machine, name: string): void => {
  const key = keyForName(name)
  if (key === undefined) throw new Error(`no key named ${name}`)
  machine.onKeypadDown(key.code)
  machine.runCycles(200_000)
}

/** A machine sitting at the monitor's first painted screen. */
const atMonitor = (slots: SlotConfig = {}): Machine => {
  const machine = build(slots)
  expect(runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))).toBe(true)
  // The splash gate: ESC, and nothing else, starts the monitor.
  press(machine, 'ESC')
  expect(runUntil(machine, () => machine.lcd.getRowText(0).includes('$'), 500_000)).toBe(true)
  return machine
}

describe('KC Monitor', () => {

  describe('boot', () => {
    it('reaches the monitor from BIOS.bin and KC Monitor.bin', () => {
      const machine = build()

      expect(runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))).toBe(true)
      expect(machine.lcd.getRowText(0)).toBe('KIM MONITOR v1.0')
      expect(machine.lcd.getRowText(1)).toBe('--ESC TO START--')
    })

    it('starts the monitor at $0800 with the byte stored there', () => {
      const machine = atMonitor()
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $00---')
      expect(machine.lcd.getRowText(1)).toBe('----------------')
    })

    it('shows the byte that is actually in memory', () => {
      const machine = build()
      machine.poke(PROGRAM_START, 0xa9)
      expect(runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))).toBe(true)
      press(machine, 'ESC')
      runUntil(machine, () => machine.lcd.getRowText(0).includes('$'), 500_000)

      expect(machine.lcd.getRowText(0)).toBe('---$0800: $A9---')
    })

    it('greets the serial terminal as well as the glass', () => {
      const machine = build()
      const sent: number[] = []
      machine.transmit = (byte) => sent.push(byte)

      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
      machine.runCycles(500_000)

      expect(String.fromCharCode(...sent)).toContain('KIM MONITOR v1.0')
    })

    /**
     * The gate is the same gate on both consoles, which is the whole point of
     * it: the terminal is told what the panel is telling you, ESC is the only
     * thing either one accepts, and one press opens both.
     *
     * The prompt matters as much as the banner. It used to go out ahead of the
     * gate, in front of a Wozmon parser that was not running yet, so a deposit
     * typed at it either vanished or landed minutes later depending on how the
     * splash happened to be dismissed. A `>` on the wire now means the parser
     * is behind it.
     */
    it('tells the terminal what the panel says, and offers no prompt yet', () => {
      const machine = build()
      const sent: number[] = []
      machine.transmit = (byte) => sent.push(byte)

      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
      machine.runCycles(500_000)

      const banner = String.fromCharCode(...sent)
      expect(banner).toContain('--ESC TO START--')
      expect(banner).not.toContain('>')
    })

    it('ignores every key but ESC at the splash', () => {
      const machine = build()
      expect(runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))).toBe(true)

      for (const name of ['RIGHT', 'INS', '0', 'UP']) press(machine, name)

      expect(machine.lcd.getRowText(1)).toBe('--ESC TO START--')
    })

    it('opens both consoles on one ESC, from either of them', () => {
      for (const openTheGate of [
        (m: Machine): void => press(m, 'ESC'),
        (m: Machine): void => {
          m.onReceive(0x1b)
          m.runCycles(200_000)
        }
      ]) {
        const machine = build()
        const sent: number[] = []
        machine.transmit = (byte) => sent.push(byte)
        runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
        machine.runCycles(500_000)
        sent.length = 0

        openTheGate(machine)
        expect(runUntil(machine, () => machine.lcd.getRowText(0).includes('$'), 500_000)).toBe(true)

        // The panel painted, and the prompt followed it onto the wire.
        expect(machine.lcd.getRowText(0)).toBe('---$0800: $00---')
        expect(String.fromCharCode(...sent)).toContain('>')
      }
    })

    /**
     * The half of the old behaviour that actually bit: a line typed at the
     * splash sat in the RX ring and was parsed once the pad opened the gate,
     * so a deposit could land long after it was typed, with nothing echoed to
     * say it had arrived. The gate discards both inputs on the way through.
     */
    it('discards what was typed at the splash instead of deferring it', () => {
      const machine = build()
      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
      machine.runCycles(500_000)

      for (const ch of '0900: EE EE EE EE\r') machine.onReceive(ch.charCodeAt(0))
      machine.runCycles(200_000)
      expect(machine.peek(0x0900)).toBe(0x00) // not parsed — nothing is running

      press(machine, 'ESC')
      runUntil(machine, () => machine.lcd.getRowText(0).includes('$'), 500_000)
      machine.runCycles(500_000)

      expect(machine.peek(0x0900)).toBe(0x00) // and not parsed afterwards either
    })
  })

  /**
   * `HW_PRESENT` after `KernalInit` is the BIOS's own account of what it found
   * on this bus. On a KIM it should read exactly `HW_SC` — nothing else is
   * fitted, and in particular no VIA, which is why the accessory bay in phase 6
   * has to read back open bus.
   */
  describe('the BIOS slot probe', () => {
    it('finds the Serial Card and nothing else', () => {
      const machine = build()
      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
      expect(machine.peek(HW_PRESENT)).toBe(HW_SC)
    })

    it('finds nothing at all with the Serial Card unfitted', () => {
      const machine = build({ io5: new Empty() })
      runUntil(machine, () => machine.lcd.getRowText(0).startsWith('KIM MONITOR'))
      expect(machine.peek(HW_PRESENT)).toBe(0x00)
    })

    it('still boots to the monitor keypad-only', () => {
      const machine = atMonitor({ io5: new Empty() })
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $00---')
    })
  })

  /**
   * The pixel buffer is what the panel in phase 5 draws, so the exit criterion
   * is about pixels and not about DDRAM. Reading the glyphs back out of the
   * buffer through the same font the controller rendered them with proves the
   * whole path: DDRAM, the A00 ROM, the 5×8 layout and the inter-character gaps.
   */
  describe('the pixel buffer', () => {
    /** Which of the 5×8 dots in a cell are lit, as a bitmap per column. */
    const cell = (machine: Machine, col: number, row: number): number[] => {
      const columns: number[] = []
      for (let x = 0; x < 5; x++) {
        let bits = 0
        for (let y = 0; y < 8; y++) {
          if (machine.lcd.pixelState(col * 6 + x, row * 9 + y) === 1) bits |= 0x80 >> y
        }
        columns.push(bits)
      }
      return columns
    }

    it('is the size the panel expects for a 16×2', () => {
      const machine = atMonitor()
      expect(machine.lcd.pixelsWidth).toBe(16 * 6 - 1)
      expect(machine.lcd.pixelsHeight).toBe(2 * 9 - 1)
    })

    it('draws the glyphs of the address the monitor is showing', () => {
      const machine = atMonitor()

      // "---$0800: $00---" — the '$', the '0' and the '8', straight out of the
      // A00 font, five column bytes each with the MSB at the top of the cell.
      expect(cell(machine, 3, 0)).toEqual([0x24, 0x54, 0xfe, 0x54, 0x48])  // $
      expect(cell(machine, 4, 0)).toEqual([0x7c, 0x8a, 0x92, 0xa2, 0x7c])  // 0
      expect(cell(machine, 5, 0)).toEqual([0x6c, 0x92, 0x92, 0x92, 0x6c])  // 8
    })

    it('leaves the inter-character gap unwritten', () => {
      const machine = atMonitor()
      for (let y = 0; y < machine.lcd.pixelsHeight; y++) {
        expect(machine.lcd.pixelState(5, y)).toBe(-1)   // the column between cells 0 and 1
      }
      for (let x = 0; x < machine.lcd.pixelsWidth; x++) {
        expect(machine.lcd.pixelState(x, 8)).toBe(-1)   // the row between lines 1 and 2
      }
    })

    it('repaints when the monitor moves', () => {
      const machine = atMonitor()
      const before = Array.from(machine.lcd.buffer)
      press(machine, '1')
      expect(Array.from(machine.lcd.buffer)).not.toEqual(before)
    })
  })

  /**
   * KIM-1 style: a hex key shifts a nibble in from the right, so keying four of
   * them walks the address across one digit at a time. This is the exit
   * criterion "keying an address on the pad moves the monitor, nibble at a time"
   * and it is checked at every step, not only at the end.
   */
  describe('keying an address', () => {
    it('shifts one nibble in per key', () => {
      const machine = atMonitor()

      press(machine, '1')
      expect(machine.lcd.getRowText(0)).toBe('---$8001: $00---')
      press(machine, '2')
      expect(machine.lcd.getRowText(0)).toBe('---$0012: $00---')
      press(machine, '3')
      expect(machine.lcd.getRowText(0)).toBe('---$0123: $00---')
      press(machine, '4')
      expect(machine.lcd.getRowText(0)).toBe('---$1234: $00---')
    })

    it('takes the letter keys as the digits A to F', () => {
      const machine = atMonitor()
      for (const key of ['0', 'A', 'B', 'C']) press(machine, key)
      expect(machine.lcd.getRowText(0)).toBe('---$0ABC: $00---')
    })

    /**
     * Nothing stops the monitor being pointed at the card's own I/O window, and
     * what it shows there is a PIA register read — $CAFE lands on PORTB, because
     * RS1:RS0 are A1:A0. Worth pinning: the overlay is not a special case the
     * monitor knows about, it is just the bus.
     */
    it('reads the PIA when the address lands in its window', () => {
      const machine = atMonitor()
      machine.poke(0xc002, 0x24)  // PORTB, while CRB still selects DDRB
      for (const key of ['C', 'A', 'F', 'E']) press(machine, key)
      expect(machine.lcd.getRowText(0)).toBe('---$CAFE: $24---')
    })

    it('shows what is at the address it lands on', () => {
      const machine = atMonitor()
      machine.poke(0x1234, 0x5a)
      for (const key of ['1', '2', '3', '4']) press(machine, key)
      expect(machine.lcd.getRowText(0)).toBe('---$1234: $5A---')
    })

    it('steps one byte at a time on ◄ and ►', () => {
      const machine = atMonitor()
      press(machine, 'RIGHT')
      expect(machine.lcd.getRowText(0)).toBe('---$0801: $00---')
      press(machine, 'LEFT')
      press(machine, 'LEFT')
      expect(machine.lcd.getRowText(0)).toBe('---$07FF: $00---')
    })

    it('steps a page at a time on PGUP and PGDN', () => {
      const machine = atMonitor()
      press(machine, 'PGUP')
      expect(machine.lcd.getRowText(0)).toBe('---$0900: $00---')
      press(machine, 'PGDN')
      press(machine, 'PGDN')
      expect(machine.lcd.getRowText(0)).toBe('---$0700: $00---')
    })
  })

  describe('editing memory', () => {
    it('says INS on the second line while the edit is armed', () => {
      const machine = atMonitor()
      press(machine, 'INS')
      expect(machine.lcd.getRowText(1)).toBe('------INS-------')
      press(machine, 'INS')
      expect(machine.lcd.getRowText(1)).toBe('----------------')
    })

    it('shifts nibbles into the byte and writes it to RAM', () => {
      const machine = atMonitor()
      for (const key of ['1', '2', '3', '4']) press(machine, key)

      press(machine, 'INS')
      press(machine, 'A')
      expect(machine.peek(0x1234)).toBe(0x0a)
      press(machine, 'E')

      expect(machine.lcd.getRowText(0)).toBe('---$1234: $AE---')
      expect(machine.peek(0x1234)).toBe(0xae)
    })

    it('zeroes the byte on DEL', () => {
      const machine = atMonitor()
      machine.poke(PROGRAM_START, 0xff)
      press(machine, 'RIGHT')
      press(machine, 'LEFT')
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $FF---')

      press(machine, 'DEL')

      expect(machine.peek(PROGRAM_START)).toBe(0x00)
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $00---')
    })

    /**
     * Keying a program in and running it, which is what the machine is for.
     * `A9 42 8D 00 04 60` — LDA #$42, STA $0400, RTS — six bytes at $0800,
     * entered on the pad and started with ▲.
     */
    it('runs a program keyed in on the pad', () => {
      const machine = atMonitor()
      press(machine, 'INS')

      for (const byte of ['A9', '42', '8D', '00', '04', '60']) {
        press(machine, byte[0])
        press(machine, byte[1])
        press(machine, 'RIGHT')
      }

      press(machine, 'INS')                 // leave edit mode
      for (const key of ['0', '8', '0', '0']) press(machine, key)
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $A9---')

      press(machine, 'UP')                  // execute
      machine.runCycles(200_000)

      expect(machine.peek(0x0400)).toBe(0x42)
    })
  })

  /**
   * The encoder ignores releases, so the monitor has to see one press per call
   * to onKeypadDown and not one per cycle the code sits in the latch. A key held
   * down on the real pad does not repeat.
   */
  describe('the encoder', () => {
    it('registers one keystroke per press', () => {
      const machine = atMonitor()
      press(machine, '1')
      const once = machine.lcd.getRowText(0)

      machine.runCycles(1_000_000)  // the code is long since read; nothing repeats

      expect(machine.lcd.getRowText(0)).toBe(once)
    })

    it('drives the monitor through the interrupt, not a polling loop', () => {
      const machine = atMonitor()
      // The CA1 flag is what raises IRQ; if the press did not set it, nothing
      // reached the ISR and the address below would not have moved.
      machine.onKeypadDown(0x01)
      machine.runCycles(2_000)
      expect(machine.peek(0xc001) & 0x80).toBe(0x00)  // already serviced
      machine.runCycles(200_000)
      expect(machine.lcd.getRowText(0)).toBe('---$8001: $00---')
    })
  })

  /**
   * Two independent input paths, as on the real machine: the pad and the serial
   * port. The KC Monitor runs a Wozmon-compatible parser concurrently with the
   * keypad, and a deposit over one shows up on the other at the next refresh.
   */
  describe('the serial monitor', () => {
    const type = (machine: Machine, text: string): void => {
      for (const character of text) {
        machine.onReceive(character.charCodeAt(0))
        machine.runCycles(20_000)
      }
      machine.runCycles(200_000)
    }

    it('deposits a byte in Wozmon syntax', () => {
      const machine = atMonitor()
      type(machine, '0800: 42\r')
      expect(machine.peek(PROGRAM_START)).toBe(0x42)
    })

    it('shows a serial deposit on the LCD at the next refresh', () => {
      const machine = atMonitor()
      expect(machine.lcd.getRowText(0)).toBe('---$0800: $00---')

      type(machine, '0800: 42\r')

      expect(machine.lcd.getRowText(0)).toBe('---$0800: $42---')
    })

    it('answers an examine with the byte at the address', () => {
      const machine = atMonitor()
      machine.poke(PROGRAM_START, 0x5a)
      const sent: number[] = []
      machine.transmit = (byte) => sent.push(byte)

      type(machine, '0800\r')

      expect(String.fromCharCode(...sent)).toContain('5A')
    })

    /**
     * `XXXX R` is a JSR through XAML, not original Wozmon's JMP, so a program
     * ending in RTS returns to the parser rather than to whatever the stack
     * happened to hold — the same contract the pad's ▲ has had all along.
     *
     * The examine after the run is the load-bearing half of this test. It is
     * answered only if the RTS landed back in SerProcess *and* the prompt that
     * follows reset the line buffer; under the old jump semantics `0400` was
     * appended to the still-live `0800 R` and re-ran the program instead.
     */
    it('runs a program with R and comes back to the prompt', () => {
      const machine = atMonitor()
      // LDA #$42, STA $0400, RTS — $0400 is the serial RX ring, which the
      // monitor is done with by the time the byte lands, and it is somewhere
      // neither console paints from.
      const program = [0xa9, 0x42, 0x8d, 0x00, 0x04, 0x60]
      program.forEach((byte, offset) => machine.poke(PROGRAM_START + offset, byte))
      const sent: number[] = []
      machine.transmit = (byte) => sent.push(byte)

      type(machine, '0800 R\r')

      expect(machine.peek(0x0400)).toBe(0x42)
      expect(String.fromCharCode(...sent)).toMatch(/> $/)

      type(machine, '0400\r')

      expect(String.fromCharCode(...sent)).toContain('0400: 42')
    })
  })
})
