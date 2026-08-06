import { readFileSync } from 'node:fs'
import { Session } from '../../debug/Session'
import { Empty } from '../../core/IO/Empty'
import { ROM } from '../../core/ROM'
import { CardROM } from '../../core/CardROM'
import type { SlotConfig } from '../../core/Machine'
import { createAccessory } from '../../core/accessories/registry'
import { loadBinary } from '../../core/ProgramImage'
import { SerialConsole } from './SerialConsole'
import { SymbolTable } from '../../debug/symbols/Symbols'

/**
 * How the machine is being talked to.
 *
 * Where 6502-EMULATOR chooses between a serial console and a video card, a KIM
 * chooses between the Serial Card and nothing: `keypad` is a machine with io5
 * vacant, driven from the pad and read off the LCD. It is a configuration the
 * firmware explicitly supports — `KC Monitor.asm` guards every ACIA access on
 * `HW_PRESENT & HW_SC` — rather than a degraded one.
 */
export type ConsoleMode = 'serial' | 'keypad'

export interface BinaryLoad {
  address: number
  bytes: Uint8Array
}

export interface HeadlessOptions {
  /** The 32 KB BIOS image. Required — the machine has no Kernal without one. */
  rom: Uint8Array
  /**
   * The Keypad Card's 8 KB ROM. Also required, and for a harder reason: the
   * card carries this machine's reset vectors, so without it the CPU starts
   * from whatever `$FFFC` happens to read as and never reaches the monitor.
   */
  cardROM: Uint8Array

  binaries?: BinaryLoad[]

  /**
   * Whether io5 holds the Serial Card. Fitted by default, because that is the
   * canonical build and the only one with a console on a TTY.
   */
  serialCard?: boolean

  /**
   * What is wired to the accessory bus at `$9400`, by its id in
   * `core/accessories/registry` — null or omitted for an empty bay.
   */
  accessory?: string | null

  baudRate?: number

  /** Stop after this many CPU cycles. */
  maxCycles?: number
  /** Stop after this much wall-clock time. */
  timeoutMs?: number
  /** Stop when the machine's serial output matches. */
  exitOn?: RegExp
  /**
   * Hold host input back until the machine's output matches.
   *
   * Anything sent before the KC Monitor has printed its banner is arriving
   * while the firmware is still probing slots and running the LCD's power-on
   * ritual. Gating on the prompt is how a script says "wait until it is
   * listening" without guessing at a cycle count.
   */
  inputAfter?: RegExp

  /** Where the machine's serial output goes. */
  onOutput?: (data: Uint8Array) => void

  /**
   * Called with the LCD's two lines whenever what the panel says changes.
   *
   * The KIM's other output channel, and on a keypad-only machine its only one.
   * Sampled at the session's chunk cadence rather than on every write, because
   * the firmware repaints a line a character at a time and reporting each
   * intermediate state would be noise.
   */
  onLCD?: (lines: string[]) => void
}

/**
 * `halted` is the machine deciding it is done: the program executed STP, so the
 * processor cannot advance again without a reset. Distinct from `stopped`,
 * which is this process being told to quit, and worth distinguishing from
 * `timeout` — a run that ends in STP has succeeded, and reporting it as a
 * timeout would exit 2 and take a passing CI job with it.
 */
export type ExitReason = 'max-cycles' | 'timeout' | 'exit-on' | 'halted' | 'stopped' | 'error'

/** Retained console output, positioned in the stream it came from. */
export interface SerialRead {
  data: string
  /** Total bytes the console has produced — the stream position after `data`. */
  cursor: number
  /** True when output before the requested `since` had already been dropped. */
  truncated: boolean
}

export interface RunResult {
  reason: ExitReason
  cycles: number
  wallMs: number
  /** Everything the machine wrote to its console, when a match was being sought. */
  output?: string
  /**
   * What the LCD finished the run showing.
   *
   * Always reported, unlike `output`: it is two lines of sixteen characters, and
   * on a keypad-only machine it is the whole of what the run produced.
   */
  lcd: string[]
  error?: string
}

/**
 * How long the tail kept for `--exit-on` matching may grow. Long enough for a
 * pattern to span several lines, bounded so a long run can't grow without end.
 */
const MATCH_WINDOW = 64 * 1024

/**
 * PHI2, in Hz — the same 1 MHz `Machine.frequency` reports.
 *
 * Named here rather than read off the machine because it is wanted before there
 * is one: the session's chunk size is a byte's worth of emulated time, and the
 * session is what builds the machine. There is nothing to keep in sync — this
 * board has one clock and the ACE is the family member with the 2 MHz jumper.
 */
const PHI2 = 1_000_000

/**
 * Runs a machine with no window, wiring its console to a byte stream.
 *
 * Possible because `src/core` has no browser or Node dependencies — the same
 * engine the desktop app runs in a renderer runs here in a bare Node process,
 * with no Electron and no display.
 */
export class HeadlessHost {
  readonly session: Session

  /**
   * The paced bridge between stdio and the ACIA, or undefined on a machine with
   * no Serial Card — there is no console to bridge to, and offering one that
   * silently swallowed bytes would be worse than not offering it.
   */
  readonly serial?: SerialConsole

  /**
   * Symbols loaded for this machine.
   *
   * Owned by the host rather than by whoever loaded them, so a `--symbols` flag
   * on the command line and a `sym.load` over the debug protocol contribute to
   * the same table.
   */
  readonly symbols = new SymbolTable()

  private readonly options: HeadlessOptions
  private readonly onOutput?: (data: Uint8Array) => void

  /** Extra consumers of console output — the debug server subscribes here. */
  private readonly outputListeners = new Set<(data: Uint8Array) => void>()

  /** Rolling tail of console output, kept only when someone is reading it. */
  private outputTail = ''

  /**
   * Total bytes the console has ever produced.
   *
   * The tail is bounded, so an absolute position in the stream is the only
   * stable way to say "output after this point". A caller that writes a command
   * and then asks to wait for its reply needs that: between the two calls the
   * machine may run millions of cycles and the reply can arrive — and be
   * scrolled out of a "from now on" window — before the wait is even set up.
   */
  private outputProduced = 0

  /** Outstanding requests to retain output, from retainOutput(). */
  private retainRequests = 0

  /** False while input is held back waiting for `inputAfter` to match. */
  private inputGateOpen: boolean

  /** What the LCD said when it was last reported, for change detection. */
  private lastLCD = ''

  private startedAt = 0
  private deadline = Infinity
  private finished = false
  private settle?: (result: RunResult) => void
  private result?: RunResult

  constructor(options: HeadlessOptions) {
    this.options = options
    this.onOutput = options.onOutput
    this.inputGateOpen = options.inputAfter === undefined

    const serialCard = options.serialCard ?? true
    const accessory = createAccessory(options.accessory)
    const slots: SlotConfig = {
      // An empty io5 is not a broken machine: `HW_PRESENT & HW_SC` comes back
      // clear and the KC Monitor takes the keypad-only path it was written to
      // support. io6 is the bay — vacant unless a circuit was asked for.
      ...(serialCard ? {} : { io5: new Empty() }),
      io6: accessory ?? new Empty()
    }

    // The scheduler drives periodic work at a byte's worth of emulated time, so
    // paced input lands at the same point in the program at any host speed.
    const baudRate = options.baudRate ?? 19200
    this.session = new Session(slots, undefined, {
      chunkCycles: Math.max(1, Math.floor((PHI2 * 10) / baudRate)),
      onChunk: () => this.onChunk()
    })

    // A STP ends the run. The Session has already paused the scheduler by the
    // time this fires, so all that is left is to settle the promise with a
    // reason that says what happened rather than letting --timeout expire.
    this.session.onStop((reason) => {
      if (reason.kind !== 'trap' || reason.detail !== 'stp') return
      // Nothing to end before run() has been called. A debugger attached with
      // --pause can step a machine onto a STP before the run has started, and
      // finishing there would mark the host done with no promise to settle —
      // the later run() would then never resolve.
      if (!this.settle) return
      this.finish('halted')
    })

    const machine = this.session.machine
    if (serialCard) this.serial = new SerialConsole(machine, baudRate)

    machine.loadROM(options.rom)
    machine.loadCardROM(options.cardROM)

    machine.transmit = (byte) => this.emit(byte)

    // Everything above changed what the CPU will fetch, so re-read the vectors —
    // which on this machine come out of the Keypad Card, not the BIOS.
    machine.reset(true)

    this.loadMedia()
    this.lastLCD = this.lcdText().join('\n')
  }

  private loadMedia(): void {
    const machine = this.session.machine

    for (const binary of this.options.binaries ?? []) {
      const status = loadBinary(machine, binary.address, binary.bytes)
      if (status !== 'ok') {
        throw new Error(
          `binary at $${binary.address.toString(16).toUpperCase().padStart(4, '0')}: ${status}`
        )
      }
    }
  }

  private emit(byte: number): void {
    const data = Uint8Array.of(byte)
    this.outputProduced++
    this.onOutput?.(data)
    for (const listener of this.outputListeners) listener(data)

    const { exitOn, inputAfter } = this.options
    if (!exitOn && !inputAfter && this.retainRequests === 0) return

    this.outputTail += String.fromCharCode(byte)
    if (this.outputTail.length > MATCH_WINDOW) {
      this.outputTail = this.outputTail.slice(-MATCH_WINDOW)
    }

    if (!this.inputGateOpen && inputAfter?.test(this.outputTail)) {
      this.inputGateOpen = true
      // Start pacing from here, or the held-back bytes all go at once.
      this.serial?.resync()
    }
  }

  /**
   * Send bytes to the machine's console, paced at the serial line rate.
   *
   * Silently dropped on a keypad-only machine rather than thrown: the CLI
   * refuses `--serial`-shaped flags for such a run up front, and a debug client
   * gets NOT_SUPPORTED from the method table, so anything reaching here is a
   * pipe with nowhere to go.
   */
  write(data: Uint8Array | string): void {
    this.serial?.write(data)
  }

  /** Watch console output as the machine produces it. Returns an unsubscribe. */
  onSerialOutput(listener: (data: Uint8Array) => void): () => void {
    this.outputListeners.add(listener)
    return () => this.outputListeners.delete(listener)
  }

  /**
   * Ask for console output to be kept for later reading. Returns a release.
   *
   * Reference-counted rather than a flag, because retaining costs a string
   * append per emitted byte and a run that nobody is reading back should not
   * pay it. `--exit-on` and `--input-after` retain implicitly.
   */
  retainOutput(): () => void {
    this.retainRequests++
    let released = false
    return () => {
      if (released) return
      released = true
      this.retainRequests--
    }
  }

  /** How many bytes the console has produced. A position in the output stream. */
  get outputCursor(): number {
    return this.outputProduced
  }

  /**
   * Console output retained so far, most recent last.
   *
   * `since` reads from an absolute stream position — see outputCursor. `clear`
   * drops what is returned, so a caller can read one command's output without
   * seeing it again next time.
   */
  readOutput(options: { since?: number; max?: number; clear?: boolean } = {}): SerialRead {
    // Where the retained tail starts in the stream. Anything before this has
    // been trimmed and cannot be recovered.
    const base = this.outputProduced - this.outputTail.length

    let text = this.outputTail
    let truncated = false

    if (options.since !== undefined) {
      truncated = options.since < base
      text = this.outputTail.slice(Math.max(0, options.since - base))
    }
    if (options.max !== undefined) text = text.slice(-options.max)

    if (options.clear) this.outputTail = ''
    return { data: text, cursor: this.outputProduced, truncated }
  }

  /**
   * What the LCD is showing, one string per row.
   *
   * The headless panel: sixteen characters by two is small enough to read as
   * text, so there is nothing here to draw and nothing to encode. `lcd.pixels`
   * over the debug protocol is where the dots themselves live.
   */
  lcdText(): string[] {
    const lcd = this.session.machine.lcd
    return Array.from({ length: lcd.rows }, (_, row) => lcd.getRowText(row))
  }

  get baudRate(): number {
    return this.serial?.baudRate ?? 0
  }

  get consoleMode(): ConsoleMode {
    return this.session.machine.acia() ? 'serial' : 'keypad'
  }

  /**
   * Run until one of the configured exit conditions fires, or stop() is called.
   *
   * `turbo` runs flat out; without it the machine is paced against the wall
   * clock the way the desktop app runs it.
   */
  run(mode: 'turbo' | 'realtime' = 'turbo', startPaused = false): Promise<RunResult> {
    this.startedAt = Date.now()
    this.deadline =
      this.options.timeoutMs === undefined ? Infinity : this.startedAt + this.options.timeoutMs

    return new Promise<RunResult>((resolve) => {
      this.settle = resolve

      // Starting paused has to mean *not started*, not started-and-then-stopped:
      // Scheduler.start() runs a whole slice synchronously, so pausing after the
      // fact would already be tens of thousands of cycles into the firmware. A
      // debugger attaching at reset has to see the reset vector.
      if (startPaused) return

      this.session.run(mode)
      // A budget small enough to be met before the first chunk still has to end.
      this.onChunk()
    })
  }

  /** End the run early — a signal, or the caller deciding it has seen enough. */
  stop(reason: ExitReason = 'stopped'): void {
    this.finish(reason)
  }

  private onChunk(): void {
    if (this.finished) return

    if (this.inputGateOpen) this.serial?.pump()
    this.reportLCD()

    const { maxCycles, exitOn } = this.options

    if (maxCycles !== undefined && this.session.cycles >= maxCycles) {
      this.finish('max-cycles')
      return
    }
    if (exitOn && exitOn.test(this.outputTail)) {
      this.finish('exit-on')
      return
    }
    if (Date.now() >= this.deadline) {
      this.finish('timeout')
    }
  }

  /** Tell a watcher what the panel says, but only when it has changed. */
  private reportLCD(): void {
    if (!this.options.onLCD) return
    const lines = this.lcdText()
    const text = lines.join('\n')
    if (text === this.lastLCD) return
    this.lastLCD = text
    this.options.onLCD(lines)
  }

  private finish(reason: ExitReason, error?: string): void {
    if (this.finished) return
    this.finished = true
    this.session.pause()

    this.result = {
      reason,
      cycles: this.session.cycles,
      wallMs: Date.now() - this.startedAt,
      ...(this.options.exitOn ? { output: this.outputTail } : {}),
      lcd: this.lcdText(),
      ...(error ? { error } : {})
    }

    this.settle?.(this.result)
  }
}

/** Read the BIOS image from disk, checking it is the 32 KB the address space expects. */
export function readROM(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path))
  if (bytes.length !== ROM.SIZE) {
    throw new Error(`${path}: ROM must be exactly ${ROM.SIZE} bytes, got ${bytes.length}`)
  }
  return bytes
}

/**
 * Read the Keypad Card's ROM, checking it is the 8 KB an AT28C64 holds.
 *
 * Separate from readROM because the two images are different sizes and a
 * mix-up is otherwise silent: a 32 KB BIOS loaded as the card ROM would be
 * rejected, but the card's 8 KB image loaded as the BIOS would leave a machine
 * that boots into the monitor and falls over the first time it calls the Kernal.
 */
export function readCardROM(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path))
  if (bytes.length !== CardROM.SIZE) {
    throw new Error(
      `${path}: the Keypad Card ROM must be exactly ${CardROM.SIZE} bytes, got ${bytes.length}`
    )
  }
  return bytes
}
