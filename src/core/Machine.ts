import { CPU } from './CPU'
import { RAM } from './RAM'
import { ROM } from './ROM'
import { CardROM } from './CardROM'
import { PIA } from './IO/PIA'
import { ACIA } from './IO/ACIA'
import { normalizeSerialCard } from './IO/SerialCard'
import type { SerialCardConfig, SerialPin } from './IO/SerialCard'
import { Empty } from './IO/Empty'
import { KeypadAttachment } from './IO/Attachments/KeypadAttachment'
import { LCDAttachment } from './IO/Attachments/LCDAttachment'
import { IO } from './IO'

/** The PIA's window on the Keypad Card — one chip, mirrored across 8 KB. */
export const PIA_START = 0xC000
export const PIA_END = 0xDFFF

/** The eight memory-mapped expansion slots, in address order from $8000. */
export type SlotName ='io1' | 'io2' | 'io3' | 'io4' | 'io5' | 'io6' | 'io7' | 'io8'

/**
 * Cards to place in the slots, overriding the standard layout.
 *
 * Pass `new Empty()` to leave a slot vacant — the BIOS probes each slot on boot
 * and adapts, and the KC Monitor guards every ACIA access on `HW_PRESENT & HW_SC`,
 * so an empty io5 is how you get the keypad-only machine the firmware supports.
 * Omitted slots get the standard card.
 *
 * A KIM only ever fills two of the eight: io5 holds the Serial Card and io6 is
 * the accessory bus. The other six are `Empty` deliberately — there is no RAM
 * bank, no RTC, no storage, no SID and no video on this machine.
 */
export type SlotConfig = Partial<Record<SlotName, IO>>

/**
 * The serial card a machine is built with when nothing names one: the Serial
 * Card, with `CTS EN` at ground, where every board has it. Its DCD and DSR are
 * tied to ground, so this is the machine as it was before cards and jumpers
 * were modelled.
 */
export const DEFAULT_SERIAL_CARD: SerialCardConfig = {
  card: 'standard',
  jumpers: { cts: 'ground' }
}

export class Machine {

  cpu: CPU
  ram: RAM
  rom: ROM

  /**
   * The Keypad Card's two devices and its ROM.
   *
   * Not optional, and not in a slot. The card overlays the top of the address
   * space rather than sitting in one of the eight windows, and a machine without
   * it is not a KIM — it is an ACE with no video card, which is 6502-EMULATOR's
   * job. So there is no `loadCart`, no `unloadCart`, and no state in which any
   * of these three is absent.
   */
  cardROM: CardROM
  pia: PIA
  keypad: KeypadAttachment
  lcd: LCDAttachment

  io1!: IO
  io2!: IO
  io3!: IO
  io4!: IO
  io5!: IO
  io6!: IO
  io7!: IO
  io8!: IO

  /**
   * PHI2, the CPU clock. 1 MHz, and not selectable: the ACE is the machine in
   * the family whose board carries the 2 MHz jumper.
   *
   * Still a field rather than a constant because it is what paces a realtime
   * run and what a snapshot records, and because cards receive PHI2 through
   * tick() and are responsible for their own clock.
   */
  frequency: number = 1_000_000

  /**
   * Clock cycles elapsed since the machine was created.
   *
   * Distinct from `cpu.cycles`, which adds each instruction's cost up front at
   * decode time and so runs ahead of the clock mid-instruction. This one counts
   * actual ticks, which is what a cycle budget has to mean. Monotonic — a reset
   * does not zero it.
   */
  cycles: number = 0

  /**
   * Bus taps for watchpoints. Left undefined the cost is one check per access,
   * which is noise beside the address decode already happening — but they are
   * only ever set while a watchpoint is armed.
   */
  onRead?: (address: number, value: number) => void
  onWrite?: (address: number, value: number) => void

  private _flowControl = true

  /**
   * RTS/CTS flow control on host input to the Serial Card: while on, bytes
   * handed to `onReceive` wait at the far end of the cable for as long as the
   * machine holds RTS high (see `ACIA.readyToReceive`). On by default, as a
   * terminal connected to the board should be; off is a far end that ignores
   * RTS.
   *
   * RTS is high from reset until `KernalInit` writes `$09`, so input sent that
   * early waits for it. After that the KC Monitor works it the way the Kernal
   * does: up at `$C0` unread bytes in its receive ring, down below `$80`, and
   * lowered around each byte it sends, because TIC `00` stops the transmitter
   * too. So a paste is held at the high mark and arrives whole, where before
   * the monitor never wrote the command register at all and this setting held
   * nothing on the stock firmware.
   *
   * A host setting — what the far end of the cable does — so it is not part
   * of a snapshot and survives one being loaded.
   */
  get flowControl(): boolean {
    return this._flowControl
  }

  set flowControl(on: boolean) {
    this._flowControl = on
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.flowControl = on
    }
  }

  private _serialCard: SerialCardConfig = DEFAULT_SERIAL_CARD

  /**
   * Which serial card io5 holds and where its jumpers are, which decide
   * whether each of CTS, DCD and DSR is tied to ground or follows the cable
   * (see `SerialCard.ts`). A jumper the card lacks is dropped; one not given is
   * at ground.
   *
   * Which card, not whether there is one: a keypad-only machine keeps this and
   * simply has no chip for it to reach.
   *
   * Configuration, like `flowControl`: not part of a snapshot, and it survives
   * one being loaded.
   */
  get serialCard(): SerialCardConfig {
    return this._serialCard
  }

  set serialCard(config: SerialCardConfig) {
    this._serialCard = normalizeSerialCard(config)
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.serialCard = this._serialCard
    }
  }

  /**
   * The far end of the serial cable drives one of its lines. It reaches the
   * chip only where the card wires that pin to the cable; CTS deasserted there
   * stops the transmitter, and DCD deasserted stops the receiver.
   */
  setSerialLine(pin: SerialPin, asserted: boolean): void {
    this.setSerialLines({ [pin]: asserted })
  }

  /** The far end drives several lines at once; the chip sees one change. */
  setSerialLines(lines: Partial<Record<SerialPin, boolean>>): void {
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.setCableLines(lines)
    }
  }

  /**
   * Whether the serial card asserts RTS on the cable (the pin low: "the far
   * end may send"). RTS reaches the cable on every card. False with no serial
   * card, where nothing drives the line.
   */
  get requestToSend(): boolean {
    for (const io of this.slots()) {
      if (io instanceof ACIA) return io.requestToSend
    }
    return false
  }

  transmit?: (data: number) => void

  //
  // Initialization
  //

  constructor(slots: SlotConfig = {}) {
    this.cpu = new CPU(this.read.bind(this), this.write.bind(this))
    this.ram = new RAM()
    this.rom = new ROM()
    this.cardROM = new CardROM()

    // The Keypad Card, built before the slots because it is not one of them.
    this.pia = new PIA()
    this.keypad = new KeypadAttachment(true, 10)
    this.lcd = new LCDAttachment(16, 2, 20)

    // The encoder's code and DA/OE lines are on Port A. The LCD straddles both:
    // its RS, R/W and E on PA5-PA7, its data bus on Port B.
    this.pia.attachToPortA(this.keypad)
    this.pia.attachToPortA(this.lcd)
    this.pia.attachToPortB(this.lcd)

    this.configure(slots)

    this.cpu.reset()
  }

  private configure(slots: SlotConfig): void {
    this.io1 = slots.io1 ?? new Empty()
    this.io2 = slots.io2 ?? new Empty()
    this.io3 = slots.io3 ?? new Empty()
    this.io4 = slots.io4 ?? new Empty()
    this.io5 = slots.io5 ?? new ACIA()
    this.io6 = slots.io6 ?? new Empty()
    this.io7 = slots.io7 ?? new Empty()
    this.io8 = slots.io8 ?? new Empty()

    // Wire the machine's outward callbacks by capability rather than by slot
    // number, so a card still reaches the host if it is moved or omitted.
    for (const io of this.slots()) {
      if (io instanceof ACIA) {
        io.transmit = (data: number) => this.transmit?.(data)
        io.flowControl = this._flowControl
        io.serialCard = this._serialCard
      }
    }
  }

  /** The eight slot cards in address order. */
  slots(): IO[] {
    return [this.io1, this.io2, this.io3, this.io4, this.io5, this.io6, this.io7, this.io8]
  }

  /** The Serial Card, or undefined when io5 is vacant (a keypad-only KIM). */
  acia(): ACIA | undefined {
    return this.io5 instanceof ACIA ? this.io5 : undefined
  }

  //
  // Methods
  //

  loadROM = (data: Uint8Array | number[] | ArrayBuffer) => {
    this.rom.load(Machine.bytes(data))
  }

  /**
   * Replace the Keypad Card's ROM with a freshly built KC Monitor image.
   *
   * Reached from Settings → FILES, not from the toolbar: it is how the firmware
   * developed in the sibling repository gets tested without burning an AT28C64,
   * and it changes the machine's own firmware rather than slotting in a
   * cartridge. `resetCPU` afterwards, so the CPU fetches the new image's vectors.
   */
  loadCardROM = (data: Uint8Array | number[] | ArrayBuffer) => {
    this.cardROM.load(Machine.bytes(data))
  }

  private static bytes(data: Uint8Array | number[] | ArrayBuffer): number[] {
    if (data instanceof ArrayBuffer) return Array.from(new Uint8Array(data))
    if (data instanceof Uint8Array) return Array.from(data)
    return data
  }

  /**
   * Re-fetch RESET and start again, without disturbing RAM or the cards.
   *
   * What loading either ROM has to be followed by: the CPU is holding vectors
   * read out of the image that has just been replaced.
   */
  resetCPU(): void {
    this.cpu.reset()
  }

  /**
   * Advance the machine by exactly `cycles` clock cycles.
   *
   * The engine's bulk-execution primitive. Deciding how many cycles to run and
   * when belongs to a scheduler, not here — see src/debug/Scheduler.
   */
  runCycles(cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      this.cpu.tick()
      this.tickIO()
    }
    this.cycles += cycles
  }

  step(): void {
    // Step through one complete instruction
    const cyclesExecuted = this.cpu.step()

    // Tick IO cards for each cycle of the instruction
    for (let i = 0; i < cyclesExecuted; i++) {
      this.tickIO()
    }
    this.cycles += cyclesExecuted
  }

  reset(coldStart: boolean): void {
    this.cpu.reset()
    this.ram.reset(coldStart)
    this.pia.reset(coldStart)
    for (const io of this.slots()) io.reset(coldStart)
  }

  tick(): void {
    // Execute one CPU clock cycle
    this.cpu.tick()

    // Tick all IO cards and handle level-triggered interrupts
    this.tickIO()

    this.cycles += 1
  }

  private tickIO(): void {
    // The PIA is ticked with the slots even though it is not in one: its
    // peripherals need the clock (the LCD's cursor blinks against it) and its
    // CA1 flag is what makes the keypad interrupt-driven.
    let interrupt = this.pia.tick(this.frequency)

    // Every slot is ticked, including the six that are empty. Empty.tick() does
    // nothing — but skipping them would make any card placed there silently
    // inert, which is a trap now that slots are configurable.
    interrupt |= this.io1.tick(this.frequency)
    interrupt |= this.io2.tick(this.frequency)
    interrupt |= this.io3.tick(this.frequency)
    interrupt |= this.io4.tick(this.frequency)
    interrupt |= this.io5.tick(this.frequency)
    interrupt |= this.io6.tick(this.frequency)
    interrupt |= this.io7.tick(this.frequency)
    interrupt |= this.io8.tick(this.frequency)

    if (interrupt & 0x80) {
      this.cpu.irqTrigger()
    } else {
      this.cpu.irqClear()
    }
    if (interrupt & 0x40) {
      this.cpu.nmi()
    }
  }

  /**
   * Whether the serial line may be sent another byte: false only while
   * `flowControl` is on and a serial card has RTS raised. True when there is no
   * serial card, where `onReceive` is a no-op and there is nothing to wait for.
   */
  get serialReady(): boolean {
    for (const io of this.slots()) {
      if (io instanceof ACIA && !io.readyToReceive) return false
    }
    return true
  }

  /**
   * Deliver a received serial byte. A no-op when no serial card is present.
   *
   * The byte goes to the far end of the card's cable, which sends it when the
   * line will take it (see `ACIA.tick`). With `flowControl` on and RTS raised it
   * waits there, so a host that cannot pace itself (a real serial port bridged
   * in by the app) is still flow-controlled. A byte sent while the card's
   * receiver is disabled (command register bit 0 clear, as after a reset) is
   * lost, as it would be at the board.
   */
  onReceive(data: number): void {
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.onData(data)
    }
  }

  /**
   * Press a key on the pad, by its encoder code — see KeypadMap.
   *
   * There is no `onKeypadUp`. The 74C922 reports the press and nothing else, so
   * neither does this: a release the hardware never sends is a release the
   * emulator must not invent.
   */
  onKeypadDown(code: number): void {
    this.keypad.press(code)
  }

  //
  // Bus Operations
  //

  read(address: number): number {
    const value = this.readBus(address)
    if (this.onRead) this.onRead(address, value)
    return value
  }

  /**
   * Bus access that does not notify the taps.
   *
   * A debugger inspecting memory must not trip a watchpoint — the watchpoint is
   * there to catch what the *program* does, and having "show me $0400" fire the
   * breakpoint watching $0400 would make it unusable. Same for a monitor write.
   */
  peek(address: number): number {
    return this.readBus(address)
  }

  poke(address: number, data: number): void {
    this.writeBus(address, data)
  }

  /**
   * The KIM's decode, and the one place this machine differs from an ACE.
   *
   * The Keypad Card overlays the top of the map, so its two windows are tested
   * *before* the BIOS ROM. That is what leaves $A000–$BFFF of BIOS.bin reachable
   * — the Kernal and the CP437 set, both still called into by the cartridge —
   * while $C000–$FFFF of the same image is unreachable on this machine, and why
   * the vectors the CPU fetches at $FFFA are the card's own.
   *
   *   $0000–$7FFF   RAM                     32 KB SRAM
   *   $8000–$9FFF   I/O slots               eight 1 KB windows
   *   $A000–$B7FF   BIOS Kernal             from BIOS.bin, still callable
   *   $B800–$BFFF   CP437 character set     from BIOS.bin, still readable
   *   $C000–$DFFF   PIA (65C21)             mirrored every 4 bytes
   *   $E000–$FFF9   Keypad Card ROM         AT28C64, 8 KB — KC Monitor
   *   $FFFA–$FFFF   CPU vectors             the Keypad Card's own
   */
  private readBus(address: number): number {
    switch (true) {
      case (address >= PIA_START && address <= PIA_END):
        // RS1:RS0 are A1:A0, so the four registers repeat the whole way up.
        return this.pia.read(address & 0x03)
      case (address >= CardROM.START && address <= CardROM.END):
        return this.cardROM.read(address - CardROM.START)
      case (address >= ROM.CODE && address <= ROM.END):
        return this.rom.read(address - ROM.START)
      case (address >= RAM.START && address <= RAM.END):
        return this.ram.read(address)
      case (address >= 0x8000 && address <= 0x83FF):
        return this.io1.read(address - 0x8000) || 0
      case (address >= 0x8400 && address <= 0x87FF):
        return this.io2.read(address - 0x8400) || 0
      case (address >= 0x8800 && address <= 0x8BFF):
        return this.io3.read(address - 0x8800) || 0
      case (address >= 0x8C00 && address <= 0x8FFF):
        return this.io4.read(address - 0x8C00) || 0
      case (address >= 0x9000 && address <= 0x93FF):
        return this.io5.read(address - 0x9000) || 0
      case (address >= 0x9400 && address <= 0x97FF):
        return this.io6.read(address - 0x9400) || 0
      case (address >= 0x9800 && address <= 0x9BFF):
        return this.io7.read(address - 0x9800) || 0
      case (address >= 0x9C00 && address <= 0x9FFF):
        return this.io8.read(address - 0x9C00) || 0
      default:
        return 0
    }
  }

  write(address: number, data: number): void {
    if (this.onWrite) this.onWrite(address, data)
    this.writeBus(address, data)
  }

  private writeBus(address: number, data: number): void {
    switch (true) {
      case (address >= RAM.START && address <= RAM.END):
        this.ram.write(address, data)
        return
      case (address >= PIA_START && address <= PIA_END):
        this.pia.write(address & 0x03, data)
        return
      case (address >= 0x8000 && address <= 0x83FF):
        this.io1.write(address - 0x8000, data)
        return
      case (address >= 0x8400 && address <= 0x87FF):
        this.io2.write(address - 0x8400, data)
        return
      case (address >= 0x8800 && address <= 0x8BFF):
        this.io3.write(address - 0x8800, data)
        return
      case (address >= 0x8C00 && address <= 0x8FFF):
        this.io4.write(address - 0x8C00, data)
        return
      case (address >= 0x9000 && address <= 0x93FF):
        this.io5.write(address - 0x9000, data)
        return
      case (address >= 0x9400 && address <= 0x97FF):
        this.io6.write(address - 0x9400, data)
        return
      case (address >= 0x9800 && address <= 0x9BFF):
        this.io7.write(address - 0x9800, data)
        return
      case (address >= 0x9C00 && address <= 0x9FFF):
        this.io8.write(address - 0x9C00, data)
        return
      default:
        // ROM and the Keypad Card's ROM. A write lands on a chip with no /WE
        // strobe wired, and goes nowhere.
        return
    }
  }

}
