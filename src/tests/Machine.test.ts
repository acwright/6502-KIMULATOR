import { Machine, PIA_START, PIA_END } from '../core/Machine'
import { CardROM } from '../core/CardROM'
import { RAM } from '../core/RAM'
import { ROM } from '../core/ROM'
import { ACIA } from '../core/IO/ACIA'
import { Empty } from '../core/IO/Empty'
import { captureSnapshot, restoreSnapshot } from '../debug/Snapshot'
import { PIA } from '../core/IO/PIA'
import type { IO } from '../core/IO'
import type { DeviceState } from '../core/DeviceState'

/** A card that records what the bus asked it, for the slot decode tests. */
class Spy implements IO {
  readonly kind = 'spy'
  reads: number[] = []
  writes: [number, number][] = []
  value = 0x5A
  ticks = 0
  interrupt = 0x00

  read(address: number): number {
    this.reads.push(address)
    return this.value
  }

  write(address: number, data: number): void {
    this.writes.push([address, data])
  }

  tick(): number {
    this.ticks++
    return this.interrupt
  }

  reset(): void {}
  serialize(): DeviceState { return { kind: this.kind } }
  deserialize(): void {}
}

/** An image whose every byte says where it came from. */
const marked = (size: number, byte: number): number[] => new Array(size).fill(byte)

describe('Machine', () => {
  let machine: Machine

  beforeEach(() => {
    machine = new Machine()
  })

  //
  // The Keypad Card
  //

  describe('the Keypad Card', () => {
    /**
     * Not optional and not in a slot. A machine without it is not a KIM — it is
     * an ACE with no video card, which is 6502-EMULATOR's job.
     */
    it('is always fitted', () => {
      expect(machine.cardROM).toBeInstanceOf(CardROM)
      expect(machine.pia).toBeInstanceOf(PIA)
      expect(machine.keypad).toBeDefined()
      expect(machine.lcd).toBeDefined()
    })

    it('has no way to remove it', () => {
      const surface = machine as unknown as Record<string, unknown>
      expect(surface.cart).toBeUndefined()
      expect(surface.loadCart).toBeUndefined()
      expect(surface.unloadCart).toBeUndefined()
    })

    it('wires the encoder to Port A and the LCD to both', () => {
      expect(machine.pia.getPortAAttachment(0)).toBe(machine.keypad)
      expect(machine.pia.getPortAAttachment(1)).toBe(machine.lcd)
      expect(machine.pia.getPortBAttachment(0)).toBe(machine.lcd)
    })

    it('fits a 16×2 panel', () => {
      expect(machine.lcd.cols).toBe(16)
      expect(machine.lcd.rows).toBe(2)
    })
  })

  //
  // Slots
  //

  describe('slots', () => {
    /**
     * Six of the eight are vacant, deliberately. There is no RAM bank, no RTC,
     * no storage, no SID and no video on this machine — and the BIOS probes each
     * slot on boot, so an empty one is not a gap, it is the configuration.
     */
    it('fits only the Serial Card, leaving the rest empty', () => {
      expect(machine.io1).toBeInstanceOf(Empty)
      expect(machine.io2).toBeInstanceOf(Empty)
      expect(machine.io3).toBeInstanceOf(Empty)
      expect(machine.io4).toBeInstanceOf(Empty)
      expect(machine.io5).toBeInstanceOf(ACIA)
      expect(machine.io6).toBeInstanceOf(Empty)
      expect(machine.io7).toBeInstanceOf(Empty)
      expect(machine.io8).toBeInstanceOf(Empty)
    })

    it('lists them in address order', () => {
      expect(machine.slots()).toEqual([
        machine.io1, machine.io2, machine.io3, machine.io4,
        machine.io5, machine.io6, machine.io7, machine.io8
      ])
    })

    it('takes an override for any slot', () => {
      const spy = new Spy()
      const configured = new Machine({ io6: spy })
      expect(configured.io6).toBe(spy)
      expect(configured.io5).toBeInstanceOf(ACIA)
    })

    /**
     * The Serial Card toggle is not decoration: KC Monitor.asm guards every ACIA
     * access on `HW_PRESENT & HW_SC`, so unfitting it is the only way to
     * exercise the keypad-only path the firmware explicitly supports.
     */
    it('runs without a Serial Card', () => {
      const keypadOnly = new Machine({ io5: new Empty() })
      expect(keypadOnly.io5).toBeInstanceOf(Empty)
      expect(keypadOnly.acia()).toBeUndefined()
    })

    it('finds the ACIA wherever it is fitted', () => {
      expect(machine.acia()).toBe(machine.io5)
    })

    it('wires the ACIA to the machine transmit callback', () => {
      const sent: number[] = []
      machine.transmit = (data) => sent.push(data)
      machine.acia()!.transmit!(0x41)
      expect(sent).toEqual([0x41])
    })
  })

  //
  // Address decode
  //

  describe('address decode', () => {
    beforeEach(() => {
      machine.loadROM(marked(ROM.SIZE, 0xB1))
      machine.loadCardROM(marked(CardROM.SIZE, 0xCA))
    })

    it('reads RAM below $8000', () => {
      machine.poke(0x0000, 0x11)
      machine.poke(0x7fff, 0x22)
      expect(machine.peek(0x0000)).toBe(0x11)
      expect(machine.peek(0x7fff)).toBe(0x22)
      expect(RAM.END).toBe(0x7fff)
    })

    it.each([
      ['io1', 0x8000, 0x83ff],
      ['io2', 0x8400, 0x87ff],
      ['io3', 0x8800, 0x8bff],
      ['io4', 0x8c00, 0x8fff],
      ['io5', 0x9000, 0x93ff],
      ['io6', 0x9400, 0x97ff],
      ['io7', 0x9800, 0x9bff],
      ['io8', 0x9c00, 0x9fff]
    ])('gives %s its 1 KB window at $%s', (slot, start, end) => {
      const spy = new Spy()
      const configured = new Machine({ [slot as string]: spy })

      expect(configured.peek(start as number)).toBe(0x5a)
      expect(configured.peek(end as number)).toBe(0x5a)
      configured.poke(start as number, 0x99)

      expect(spy.reads).toEqual([0x000, 0x3ff])
      expect(spy.writes).toEqual([[0x000, 0x99]])
    })

    it('reads the BIOS at $A000–$BFFF', () => {
      expect(machine.peek(0xa000)).toBe(0xb1)
      expect(machine.peek(0xbfff)).toBe(0xb1)
    })

    it('reads the BIOS by offset from $8000, as the image is laid out', () => {
      const image = marked(ROM.SIZE, 0x00)
      image[0xa000 - ROM.START] = 0x77
      machine.loadROM(image)
      expect(machine.peek(0xa000)).toBe(0x77)
    })

    it('reads the PIA across $C000–$DFFF', () => {
      expect(PIA_START).toBe(0xc000)
      expect(PIA_END).toBe(0xdfff)
      machine.poke(0xc001, 0x24)  // CRA
      expect(machine.peek(0xc001)).toBe(0x24)
    })

    /**
     * RS1:RS0 are A1:A0, so the four registers repeat every four bytes the whole
     * way up the window. That is not a convenience of the emulator's — it is
     * what happens when only two address lines reach the chip.
     */
    it('mirrors the PIA every four bytes', () => {
      machine.poke(0xc001, 0x24)
      for (const address of [0xc005, 0xc0f1, 0xc801, 0xdffd]) {
        expect(machine.peek(address)).toBe(0x24)
      }
    })

    it('reads the Keypad Card ROM at $E000–$FFFF', () => {
      expect(machine.peek(0xe000)).toBe(0xca)
      expect(machine.peek(0xffff)).toBe(0xca)
    })

    it('reads nothing below $8000 from either ROM', () => {
      expect(machine.peek(0x7fff)).toBe(0x00)
    })
  })

  //
  // Overlay precedence
  //

  describe('overlay precedence', () => {
    /**
     * The one thing that makes this a KIM rather than an ACE. The Keypad Card
     * overlays the top of the map, so its two windows are decoded *before* the
     * BIOS ROM — leaving $A000–$BFFF of BIOS.bin reachable while $C000–$FFFF of
     * the same image is not, and putting the vectors the CPU fetches inside the
     * card's own ROM.
     */
    beforeEach(() => {
      machine.loadROM(marked(ROM.SIZE, 0xB1))
      machine.loadCardROM(marked(CardROM.SIZE, 0xCA))
    })

    it('puts the Keypad Card ROM over the BIOS from $E000 up', () => {
      expect(machine.rom.read(0xe000 - ROM.START)).toBe(0xb1)  // the BIOS image has bytes there
      expect(machine.peek(0xe000)).toBe(0xca)                  // the bus never sees them
    })

    it('puts the PIA over the BIOS across $C000–$DFFF', () => {
      expect(machine.rom.read(0xc000 - ROM.START)).toBe(0xb1)
      expect(machine.peek(0xc000)).not.toBe(0xb1)
    })

    it('leaves the Kernal and the CP437 set reachable', () => {
      expect(machine.peek(ROM.CODE)).toBe(0xb1)
      expect(machine.peek(0xb7ff)).toBe(0xb1)
      expect(machine.peek(0xb800)).toBe(0xb1)
      expect(machine.peek(0xbfff)).toBe(0xb1)
    })

    it('fetches the vectors from the card, not the BIOS', () => {
      const image = marked(CardROM.SIZE, 0x00)
      image[0xfffc - CardROM.START] = 0x34
      image[0xfffd - CardROM.START] = 0x12
      machine.loadCardROM(image)
      machine.resetCPU()

      expect(machine.cpu.pc).toBe(0x1234)
    })
  })

  //
  // Loading
  //

  describe('loading', () => {
    it('takes a BIOS image as bytes, a typed array or a buffer', () => {
      const image = marked(ROM.SIZE, 0x42)
      for (const form of [image, Uint8Array.from(image), Uint8Array.from(image).buffer]) {
        const target = new Machine()
        target.loadROM(form)
        expect(target.peek(0xa000)).toBe(0x42)
      }
    })

    it('takes a Keypad Card image the same three ways', () => {
      const image = marked(CardROM.SIZE, 0x43)
      for (const form of [image, Uint8Array.from(image), Uint8Array.from(image).buffer]) {
        const target = new Machine()
        target.loadCardROM(form)
        expect(target.peek(0xe000)).toBe(0x43)
      }
    })

    it('refuses a Keypad Card image that is not 8 KB', () => {
      machine.loadCardROM(marked(CardROM.SIZE, 0xCA))
      machine.loadCardROM(marked(ROM.SIZE, 0xB1))  // a BIOS pointed at the wrong field
      expect(machine.peek(0xe000)).toBe(0xca)
    })

    it('re-reads the vectors on resetCPU', () => {
      const first = marked(CardROM.SIZE, 0x00)
      first[0xfffc - CardROM.START] = 0x00
      first[0xfffd - CardROM.START] = 0xe0
      machine.loadCardROM(first)
      machine.resetCPU()
      expect(machine.cpu.pc).toBe(0xe000)

      const second = marked(CardROM.SIZE, 0x00)
      second[0xfffc - CardROM.START] = 0x00
      second[0xfffd - CardROM.START] = 0xf0
      machine.loadCardROM(second)
      machine.resetCPU()
      expect(machine.cpu.pc).toBe(0xf000)
    })
  })

  //
  // Running
  //

  describe('running', () => {
    it('ticks the PIA and every slot once per cycle', () => {
      const spies = Array.from({ length: 8 }, () => new Spy())
      const configured = new Machine({
        io1: spies[0], io2: spies[1], io3: spies[2], io4: spies[3],
        io5: spies[4], io6: spies[5], io7: spies[6], io8: spies[7]
      })
      const pia = jest.spyOn(configured.pia, 'tick')

      configured.runCycles(10)

      expect(pia).toHaveBeenCalledTimes(10)
      for (const spy of spies) expect(spy.ticks).toBe(10)
    })

    it('counts clock cycles, and does not zero them on reset', () => {
      machine.runCycles(100)
      expect(machine.cycles).toBe(100)
      machine.reset(true)
      expect(machine.cycles).toBe(100)
    })

    /**
     * The counter has to move *during* a slice, not at the end of one.
     *
     * Nothing outside the machine can tell the difference — a caller reads it
     * between calls either way — and nothing inside this machine reads it that
     * way yet: no card is handed the cycle count on a bus access, and
     * `SerialConsole.pump()` is called between slices by contract.
     *
     * It is pinned anyway because the sibling 6502-EMULATOR shares this
     * primitive and *does* read it mid-slice: its flash cartridge measures a
     * program's busy window against it, and a frozen counter made that window
     * last the rest of the slice. The two machines should not disagree about
     * what this counter means.
     */
    it('advances the cycle counter inside a slice, not after it', () => {
      const seen: number[] = []
      const watcher = new Spy()
      const watched = new Machine({ io6: watcher })
      watcher.tick = (): number => { seen.push(watched.cycles); return 0 }

      watched.runCycles(4)
      expect(seen).toEqual([0, 1, 2, 3])
    })

    it('raises the CPU IRQ while a card asserts it', () => {
      const spy = new Spy()
      const configured = new Machine({ io6: spy })
      const trigger = jest.spyOn(configured.cpu, 'irqTrigger')
      const clear = jest.spyOn(configured.cpu, 'irqClear')

      spy.interrupt = 0x80
      configured.runCycles(1)
      expect(trigger).toHaveBeenCalled()

      spy.interrupt = 0x00
      configured.runCycles(1)
      expect(clear).toHaveBeenCalled()
    })

    it('raises NMI on bit 6', () => {
      const spy = new Spy()
      const configured = new Machine({ io6: spy })
      const nmi = jest.spyOn(configured.cpu, 'nmi')
      spy.interrupt = 0x40
      configured.runCycles(1)
      expect(nmi).toHaveBeenCalled()
    })

    it('resets the PIA with the rest of the machine', () => {
      const reset = jest.spyOn(machine.pia, 'reset')
      machine.reset(true)
      expect(reset).toHaveBeenCalledWith(true)
    })

    it('clears RAM on a cold start and keeps it on a warm one', () => {
      machine.poke(0x0400, 0x99)
      machine.reset(false)
      expect(machine.peek(0x0400)).toBe(0x99)
      machine.reset(true)
      expect(machine.peek(0x0400)).toBe(0x00)
    })
  })

  //
  // Inputs
  //

  describe('inputs', () => {
    it('delivers a received byte to the ACIA', () => {
      const onData = jest.spyOn(machine.acia()!, 'onData')
      machine.onReceive(0x41)
      expect(onData).toHaveBeenCalledWith(0x41)
    })

    describe.each([
      { flowControl: true, holds: true },
      { flowControl: false, holds: false }
    ])('with flow control $flowControl', ({ flowControl, holds }) => {
      it(holds
        ? 'serialReady follows the Serial Card\'s RTS, and is true with no card'
        : 'serialReady stays true whatever RTS does', () => {
        machine.flowControl = flowControl
        expect(machine.serialReady).toBe(!holds) // reset: $00, RTSB high
        machine.write(0x9002, 0x09) // io5 command register: DTR on, RTSB low
        expect(machine.serialReady).toBe(true)
        machine.write(0x9002, 0x01) // DTR on, RTSB high
        expect(machine.serialReady).toBe(!holds)
        machine.write(0x9002, 0x09) // RTSB low, what KernalInit writes
        expect(machine.serialReady).toBe(true)

        const keypadOnly = new Machine({ io5: new Empty() })
        keypadOnly.flowControl = flowControl
        expect(keypadOnly.serialReady).toBe(true)
      })

      it('reaches a serial card in any slot, including one fitted by the caller', () => {
        const fitted = new Machine({ io2: new ACIA() })
        fitted.flowControl = flowControl
        expect((fitted.io2 as ACIA).flowControl).toBe(flowControl)
        expect(fitted.acia()!.flowControl).toBe(flowControl)
      })

      it(holds
        ? 'input sent while RTS is high reaches the machine once RTS drops'
        : 'input sent while RTS is high reaches the machine at once', () => {
        machine.flowControl = flowControl
        machine.write(0x9002, 0x03) // DTR on, receive IRQ off, RTSB high
        machine.onReceive(0x41)
        machine.runCycles(10)
        expect(machine.read(0x9001) & 0x08).toBe(holds ? 0 : 0x08)
        machine.write(0x9002, 0x0b) // RTSB low
        machine.runCycles(10)
        expect(machine.read(0x9000)).toBe(0x41)
      })
    })

    it('has flow control on by default, and keeps it across a snapshot restore', () => {
      expect(machine.flowControl).toBe(true)
      expect(machine.acia()!.flowControl).toBe(true)
      const on = captureSnapshot(machine)
      machine.flowControl = false
      restoreSnapshot(machine, on)
      machine.reset(true)
      expect(machine.flowControl).toBe(false)
      expect(machine.acia()!.flowControl).toBe(false)
      expect(JSON.stringify(captureSnapshot(machine))).not.toContain('flowControl')
    })

    it('drops a received byte when no Serial Card is fitted', () => {
      const keypadOnly = new Machine({ io5: new Empty() })
      expect(() => keypadOnly.onReceive(0x41)).not.toThrow()
    })

    it('presses a key on the pad by encoder code', () => {
      machine.onKeypadDown(0x13)
      expect(machine.keypad.getCurrentKey()).toBe(0x13)
    })

    /**
     * The 74C922 reports the press and nothing else, so neither does this. A
     * release the hardware never sends is one the emulator must not invent.
     */
    it('has no key release', () => {
      expect((machine as unknown as Record<string, unknown>).onKeypadUp).toBeUndefined()
    })
  })

  //
  // Bus taps
  //

  describe('bus taps', () => {
    it('notifies a read tap', () => {
      const seen: [number, number][] = []
      machine.onRead = (address, value) => seen.push([address, value])
      machine.poke(0x0400, 0x77)
      machine.read(0x0400)
      expect(seen).toEqual([[0x0400, 0x77]])
    })

    it('notifies a write tap', () => {
      const seen: [number, number][] = []
      machine.onWrite = (address, value) => seen.push([address, value])
      machine.write(0x0400, 0x77)
      expect(seen).toEqual([[0x0400, 0x77]])
    })

    /**
     * A debugger inspecting memory must not trip a watchpoint — "show me $0400"
     * firing the breakpoint watching $0400 would make it unusable.
     */
    it('leaves peek and poke silent', () => {
      const seen: number[] = []
      machine.onRead = (address) => seen.push(address)
      machine.onWrite = (address) => seen.push(address)
      machine.poke(0x0400, 0x77)
      machine.peek(0x0400)
      expect(seen).toEqual([])
    })
  })

  //
  // Writes that go nowhere
  //

  describe('writes to ROM', () => {
    it('changes nothing in the BIOS', () => {
      machine.loadROM(marked(ROM.SIZE, 0xB1))
      machine.poke(0xa000, 0x00)
      expect(machine.peek(0xa000)).toBe(0xb1)
    })

    it('changes nothing in the Keypad Card ROM', () => {
      machine.loadCardROM(marked(CardROM.SIZE, 0xCA))
      machine.poke(0xe000, 0x00)
      machine.poke(0xfffc, 0x00)
      expect(machine.peek(0xe000)).toBe(0xca)
      expect(machine.peek(0xfffc)).toBe(0xca)
    })
  })
})
