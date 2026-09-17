/**
 * End-to-end tests for the headless host.
 *
 * These boot the real bundled BIOS and the real KC Monitor, so nothing here is
 * stubbed — if the firmware stops booting, or the serial path or the LCD
 * breaks, these fail.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { HeadlessHost, readROM, readCardROM } from '../../host/headless/HeadlessHost'
import type { HeadlessOptions } from '../../host/headless/HeadlessHost'
import { SerialConsole } from '../../host/headless/SerialConsole'
import { Machine } from '../../core/Machine'
import { ACIA } from '../../core/IO/ACIA'
import { Empty } from '../../core/IO/Empty'
import { LEDLatch } from '../../core/accessories/LEDLatch'
import { CardROM } from '../../core/CardROM'

const ROOT = join(__dirname, '../../..')
const BIOS = new Uint8Array(readFileSync(join(ROOT, 'assets/roms/BIOS.bin')))
const KC_MONITOR = new Uint8Array(readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin')))

/**
 * Enough emulated time to boot and drive the monitor, with room to spare.
 *
 * Generous because `LcdInit` runs the HD44780's power-on ritual with four
 * ~41 ms software delays in it — about 1.8 M cycles before the splash appears,
 * and there is no honest way to skip them.
 */
const BOOT_BUDGET = 6_000_000

/**
 * The paste test's transcripts, with the far end honouring RTS and ignoring it.
 *
 * Captured from the bundled KC Monitor (6502-KIM `53cb4e1`) with the procedure
 * in `pasteInto` below. The 1.0.9 pair used to be one number, because the two
 * runs were byte-identical: nothing in that firmware ever raised RTS.
 */
const PASTE_TRANSCRIPT_ON_LENGTH = 909
const PASTE_TRANSCRIPT_ON_SHA256 = 'db1597f4e3c24d902ef6f91c4c43b1705762a0991b1608ed56ca88e4c66aefd2'
const PASTE_TRANSCRIPT_OFF_LENGTH = 828
const PASTE_TRANSCRIPT_OFF_SHA256 = '8560b1c5f72377fa3478357d07c38b5f0a29aea981fda81966692148cb1bf82a'

// These boot real ROMs, and under parallel workers they contend for CPU with
// every other suite. The work is bounded in emulated cycles, not wall time, so
// a generous ceiling avoids a flaky timeout without hiding a real hang.
jest.setTimeout(60_000)

/** ESC at the splash starts the monitor, on the pad and on the wire alike. */
const ESC = '\x1b'
const CR = '\r'

function host(options: Partial<HeadlessOptions> = {}) {
  let output = ''
  const h = new HeadlessHost({
    rom: BIOS,
    cardROM: KC_MONITOR,
    maxCycles: BOOT_BUDGET,
    onOutput: (data) => {
      output += Buffer.from(data).toString('binary')
    },
    ...options
  })
  return { host: h, read: () => output }
}

describe('HeadlessHost', () => {
  describe('the machine it builds', () => {
    it('fits the Serial Card by default, and leaves the bay empty', () => {
      const { host: h } = host()
      expect(h.session.machine.io5).toBeInstanceOf(ACIA)
      expect(h.session.machine.io6).toBeInstanceOf(Empty)
      expect(h.consoleMode).toBe('serial')
    })

    /**
     * Not a degraded machine: `KC Monitor.asm` guards every ACIA access on
     * `HW_PRESENT & HW_SC`, so this is the keypad-only path the firmware was
     * written to support, and the only way to exercise it.
     */
    it('leaves io5 vacant when the Serial Card is pulled, and builds no console', () => {
      const { host: h } = host({ serialCard: false })
      expect(h.session.machine.io5).toBeInstanceOf(Empty)
      expect(h.session.machine.acia()).toBeUndefined()
      expect(h.serial).toBeUndefined()
      expect(h.consoleMode).toBe('keypad')
    })

    it('wires an accessory into the bay by its registry id', () => {
      expect(host({ accessory: 'led-latch' }).host.session.machine.io6).toBeInstanceOf(LEDLatch)
      // An id this build has never heard of leaves the bay empty rather than
      // failing the boot — the CLI is what refuses a typo.
      expect(host({ accessory: 'nope' }).host.session.machine.io6).toBeInstanceOf(Empty)
    })

    /**
     * The reset vectors come out of the Keypad Card, not the BIOS: `$FFFC` of
     * `BIOS.bin` is not on this machine's bus. A host that reset onto the BIOS
     * image would start somewhere that is not the monitor.
     */
    it('resets through the Keypad Card vectors', () => {
      const { host: h } = host()
      const vector =
        KC_MONITOR[0xfffc - CardROM.START]! | (KC_MONITOR[0xfffd - CardROM.START]! << 8)
      expect(h.session.machine.cpu.pc).toBe(vector)
    })
  })

  describe('serial console', () => {
    it('boots to the KC Monitor and answers on the wire', async () => {
      const { host: h, read } = host()

      const result = await h.run('turbo')

      expect(read()).toContain('KIM MONITOR')
      expect(result.reason).toBe('max-cycles')
    })

    /**
     * The monitor's own Wozmon syntax, over a TTY.
     *
     * `$0800` is `PROGRAM_START`, and everything below it belongs to the
     * firmware: `$0200-$027F` is the KC Monitor's Wozmon line buffer, the very
     * line being typed, `$0400-$04FF` is its serial RX ring, and `$0300-$03FF`
     * is `KERNAL_VARS`, whose first two bytes are `IRQ_PTR`. A deposit at `$0300`
     * therefore replaces the IRQ vector, and the next character to arrive sends
     * the CPU into empty RAM — which looks exactly like a broken serial path
     * and is not one. Asserting the machine is still in ROM afterwards is what
     * tells those two apart.
     */
    it('takes a deposit typed at the prompt and reads it back', async () => {
      const { host: h, read } = host({
        maxCycles: 12_000_000,
        inputAfter: /ESC TO START/
      })
      h.write(`${ESC}0800: A9 41 EA${CR}0800.0802${CR}`)

      await h.run('turbo')

      expect(read()).toMatch(/0800: A9 41 EA/)
      expect(h.session.machine.peek(0x0800)).toBe(0xa9)
      // Still executing firmware, not wandering through RAM.
      expect(h.session.machine.cpu.pc).toBeGreaterThanOrEqual(0x8000)
    })

    it('holds input back until the splash appears', async () => {
      // Anything sent while the firmware is still probing slots and running the
      // LCD's power-on ritual is swallowed. Without the gate this deposit lands
      // in the middle of the boot and the monitor never sees it.
      //
      // Wait on the splash, not on the prompt: the firmware holds at
      // `--ESC TO START--` and the `> ` does not appear until the ESC below
      // opens the gate, so gating on `>` would wait for input it is holding.
      const { host: h } = host({ maxCycles: 12_000_000, inputAfter: /ESC TO START/ })
      h.write(`${ESC}0800: 5A${CR}`)

      await h.run('turbo')

      expect(h.session.machine.peek(0x0800)).toBe(0x5a)
    })

    describe('a program pasted at 19,200 baud', () => {
      // Twenty Wozmon deposit lines in one write, 160 bytes: the way bin2woz
      // output arrives from the Paste box or a pipe.
      const program = Array.from({ length: 160 }, (_, i) => (i * 37 + 11) & 0xff)
      const lines = Array.from({ length: 20 }, (_, row) => {
        const address = (0x0800 + row * 8).toString(16).toUpperCase().padStart(4, '0')
        const bytes = program.slice(row * 8, row * 8 + 8)
        return `${address}: ${bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`
      })
      const paste = lines.map((line) => `${line}${CR}`).join('')

      /**
       * Boot to the monitor prompt and paste, driving the host the way its
       * scheduler does — a byte's worth of cycles, then a pump — for fixed
       * budgets, so two runs cannot differ by where a wait happened to end.
       */
      function pasteInto(flowControl: boolean) {
        const h = new HeadlessHost({ rom: BIOS, cardROM: KC_MONITOR, baudRate: 19200, flowControl })
        const machine = h.session.machine
        const out = { text: '' }
        machine.transmit = (byte) => {
          out.text += String.fromCharCode(byte)
        }
        let rtsRaised = false
        const chunk = Math.floor((machine.frequency * 10) / h.baudRate)
        const budget = (cycles: number): void => {
          for (let spent = 0; spent < cycles; spent += chunk) {
            machine.runCycles(chunk)
            h.serial!.pump()
            if ((machine.peek(0x9002) & 0x0d) === 0x01) rtsRaised = true
          }
        }
        budget(BOOT_BUDGET)
        h.write(ESC)
        budget(1_000_000)
        h.write(paste)
        budget(20_000_000)
        return { h, machine, out, rtsRaised }
      }

      /**
       * Rollout bug 3, and what it took to fix it (6502-KIM `53cb4e1`).
       *
       * This paste used to lose nine of its twenty lines, identically with flow
       * control on and off, because the monitor took one byte per loop pass and
       * repainted the LCD after every deposit line — ~22 ms of panel time
       * against ~17 ms of line time — until its ring lapped its own reader. And
       * because it never wrote the command register after `InitSC`'s `$09`,
       * RTS never rose and flow control had nothing to hold.
       *
       * Now the ring is drained dry per pass and the panel painted once, and
       * RTS goes up at `$C0` unread bytes. Every line lands.
       */
      it('arrives whole with flow control on, holding the far end off at the high mark', () => {
        const { h, machine, out, rtsRaised } = pasteInto(true)
        expect(out.text).toContain('KIM MONITOR')

        // The monitor really did stop the terminal, and the terminal really did
        // wait rather than drop anything.
        expect(rtsRaised).toBe(true)
        expect(h.serial!.pendingBytes).toBe(0)
        expect(machine.acia()!.queuedBytes).toBe(0)

        // All 160 bytes of all 20 lines, and a live prompt at the end of it.
        expect(Array.from({ length: 160 }, (_, i) => machine.peek(0x0800 + i))).toEqual(program)
        expect(machine.serialReady).toBe(true)
        expect(out.text).toMatch(/> $/)
      })

      /**
       * With the far end ignoring RTS nothing holds it, so the ring runs above
       * the high-water mark for most of the paste. Two things keep that from
       * costing input: a full ring drops the byte arriving rather than lapping
       * the reader, and above the mark the console stops echoing rather than
       * lowering RTS to speak — every one of those windows would let more in.
       *
       * So this degrades in the echo, which nobody is reading during a paste,
       * and not in the deposits. It is lossier on a board, where a byte out
       * costs a byte's line time; here the transmitter is instant.
       */
      it('degrades in the echo, not the deposits, when the far end ignores RTS', () => {
        const on = pasteInto(true)
        const off = pasteInto(false)

        expect(Array.from({ length: 160 }, (_, i) => off.machine.peek(0x0800 + i))).toEqual(program)
        expect(off.out.text).toMatch(/> $/) // ...and it is still answering

        // The transcripts used to be byte-identical, which was the tell that
        // the flag did nothing. Now the flooded run says less.
        expect(off.out.text).not.toBe(on.out.text)
        expect(off.out.text.length).toBeLessThan(on.out.text.length)
      })

      /**
       * Nothing here reads the host clock, so the same ROMs and the same input
       * give the same run every time — which is what makes a transcript worth
       * pinning at all. These two are the fixed firmware's, captured with this
       * exact procedure; they move when the ROM does.
       */
      it('gives the same run every time', () => {
        for (const [flowControl, length, sha] of [
          [true, PASTE_TRANSCRIPT_ON_LENGTH, PASTE_TRANSCRIPT_ON_SHA256],
          [false, PASTE_TRANSCRIPT_OFF_LENGTH, PASTE_TRANSCRIPT_OFF_SHA256]
        ] as const) {
          const { machine, out } = pasteInto(flowControl)
          expect(machine.cycles).toBe(27_001_000)
          expect(out.text.length).toBe(length)
          expect(createHash('sha256').update(out.text, 'binary').digest('hex')).toBe(sha)
        }
      })
    })
  })

  describe('the LCD', () => {
    it('reports the panel as two lines of text', async () => {
      const { host: h } = host()
      await h.run('turbo')

      const lines = h.lcdText()
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('KIM MONITOR')
      // Sixteen columns, blanks included — trailing spaces are a state of the
      // panel, not padding to be trimmed.
      expect(lines[0]).toHaveLength(16)
    })

    it('tells a watcher only when what the panel says changes', async () => {
      const seen: string[] = []
      const { host: h } = host({ onLCD: (lines) => seen.push(lines.join('|')) })

      await h.run('turbo')

      expect(seen.length).toBeGreaterThan(0)
      expect(seen.some((text) => text.includes('KIM MONITOR'))).toBe(true)
      // Sampled at the chunk cadence, so two consecutive reports are never the
      // same panel twice.
      expect(new Set(seen).size).toBe(seen.length)
    })

    /**
     * On a keypad-only machine this is the whole of what a run produced, which
     * is why the result carries it whether or not anyone asked.
     */
    it('carries the panel in the run result', async () => {
      const { host: h } = host({ serialCard: false })
      const result = await h.run('turbo')
      expect(result.lcd).toEqual(h.lcdText())
    })
  })

  describe('the pad', () => {
    it('runs to the splash with no console at all', async () => {
      const { host: h } = host({ serialCard: false, maxCycles: 3_000_000 })
      await h.run('turbo')
      expect(h.lcdText()[1]).toContain('ESC TO START')
    })

    /**
     * The pad is the only way into a machine with no Serial Card, and the
     * splash is what it is waiting for. Pressed from the chunk cadence — the
     * same clock `keypad.press` paces a sequence on — because the 74C922
     * latches one code and the monitor's interrupt handler reading it is what
     * makes room for the next.
     */
    it('starts the monitor from a keypress on the pad', async () => {
      const { host: h } = host({ serialCard: false, maxCycles: 9_000_000 })

      let pressed = false
      const off = h.session.onChunk(() => {
        if (pressed || !h.lcdText()[1]?.includes('ESC TO START')) return
        pressed = true
        h.session.machine.onKeypadDown(0x10) // ESC
      })
      await h.run('turbo')
      off()

      expect(pressed).toBe(true)
      // The monitor's own display: an address and the byte at it.
      expect(h.lcdText()[0]).toMatch(/\$[0-9A-F]{4}: \$[0-9A-F]{2}/)
    })
  })

  describe('exit conditions', () => {
    it('stops on a cycle budget', async () => {
      const { host: h } = host({ maxCycles: 100_000 })
      const result = await h.run('turbo')

      expect(result.reason).toBe('max-cycles')
      expect(result.cycles).toBeGreaterThanOrEqual(100_000)
    })

    it('stops when output matches, long before the budget', async () => {
      const { host: h } = host({ exitOn: /KIM MONITOR/, maxCycles: BOOT_BUDGET })

      const result = await h.run('turbo')

      expect(result.reason).toBe('exit-on')
      expect(result.cycles).toBeLessThan(BOOT_BUDGET)
    })

    it('stops when asked to', async () => {
      const { host: h } = host({ maxCycles: 1e9 })
      setTimeout(() => h.stop(), 5)

      const result = await h.run('turbo')
      expect(result.reason).toBe('stopped')
    })

    it('ends the run when the program halts the processor', async () => {
      // A card ROM that STPs straight away rather than the monitor: the point is
      // which exit condition fires, and a one-instruction program leaves no
      // doubt.
      const card = new Uint8Array(CardROM.SIZE).fill(0xea)
      card[0] = 0xdb // STP at $E000
      card[0xfffc - CardROM.START] = 0x00
      card[0xfffd - CardROM.START] = 0xe0

      const { host: h } = host({ cardROM: card, maxCycles: 1e9, timeoutMs: 10_000 })
      const result = await h.run('turbo')

      // Not 'timeout', which would exit 2 and fail a CI job for a program that
      // did exactly what it was written to do.
      expect(result.reason).toBe('halted')
      expect(result.cycles).toBeLessThan(100_000)
    })

    it('reports a timeout', async () => {
      const { host: h } = host({ maxCycles: 1e12, timeoutMs: 20 })
      const result = await h.run('turbo')
      expect(result.reason).toBe('timeout')
    })
  })

  describe('media loading', () => {
    it('loads a binary into RAM before the machine boots', () => {
      const bytes = Uint8Array.of(0xa9, 0x41, 0x60)
      const { host: h } = host({ binaries: [{ address: 0x0800, bytes }] })

      expect(h.session.machine.peek(0x0800)).toBe(0xa9)
      expect(h.session.machine.peek(0x0802)).toBe(0x60)
    })

    it('rejects a binary that would run past the top of RAM', () => {
      // RAM ends at $7FFF; $8000 and up is I/O.
      expect(() => host({ binaries: [{ address: 0x7ff0, bytes: new Uint8Array(64) }] })).toThrow(
        /out-of-range/
      )
    })
  })

  describe('reading the images from disk', () => {
    it('checks each one is the size its chip holds', () => {
      const bios = join(ROOT, 'assets/roms/BIOS.bin')
      const card = join(ROOT, 'assets/roms/KCMonitor.bin')

      expect(readROM(bios)).toHaveLength(0x8000)
      expect(readCardROM(card)).toHaveLength(CardROM.SIZE)

      // The mix-up worth catching: a 32 KB BIOS in the card's slot would be
      // refused anyway, but the card's 8 KB image loaded as the BIOS leaves a
      // machine that boots and falls over the first time it calls the Kernal.
      expect(() => readROM(card)).toThrow(/exactly 32768/)
      expect(() => readCardROM(bios)).toThrow(/exactly 8192/)
    })
  })

  describe('determinism', () => {
    /**
     * A KIM needs no `--rtc`. Nothing in this machine reads the host clock —
     * there is no clock card to read — so the same ROMs, the same input and the
     * same cycle budget land in the same state every time, which is what makes
     * an emulator-based test trustworthy in CI.
     */
    it('two runs of the same program produce identical machines', async () => {
      const once = async (): Promise<string> => {
        const { host: h } = host({ maxCycles: 3_000_000 })
        await h.run('turbo')
        return JSON.stringify(h.session.machine.ram.serialize())
      }

      expect(await once()).toBe(await once())
    })
  })

  describe('serving a debugger', () => {
    /**
     * Starting paused has to mean not started at all.
     *
     * Scheduler.start() runs a whole turbo slice synchronously, so pausing
     * after calling run() would already be tens of thousands of cycles into the
     * firmware — and a debugger attaching at reset has to see the reset vector.
     */
    it('starts paused at the reset vector, having run nothing', async () => {
      const { host: h } = host()
      const pending = h.run('turbo', true)

      expect(h.session.cycles).toBe(0)
      expect(h.session.isRunning).toBe(false)
      // $FFFC/$FFFD, read straight off the bus — which is the card, not the BIOS.
      const vector = h.session.machine.peek(0xfffc) | (h.session.machine.peek(0xfffd) << 8)
      expect(h.session.machine.cpu.pc).toBe(vector)

      h.stop('stopped')
      await pending
    })

    it('retains output only while somebody has asked for it', async () => {
      const { host: h } = host({ maxCycles: 3_000_000 })

      // No retain request and no exit-on: nothing is kept.
      await h.run('turbo')
      expect(h.readOutput().data).toBe('')

      const second = host({ maxCycles: 3_000_000 })
      const release = second.host.retainOutput()
      await second.host.run('turbo')

      expect(second.host.readOutput().data).toContain('KIM MONITOR')
      release()
    })

    /**
     * The cursor is what makes "wait for the reply to what I just sent" work.
     *
     * A one-shot client writes, exits, and a later process waits — by which
     * time the machine has run far enough in turbo to have printed and scrolled
     * past the reply. An absolute stream position survives that; "from now"
     * cannot.
     */
    it('reads output from an absolute position in the stream', async () => {
      const { host: h } = host({ maxCycles: 3_000_000 })
      const release = h.retainOutput()
      await h.run('turbo')

      const all = h.readOutput()
      expect(all.cursor).toBe(all.data.length)

      const tail = h.readOutput({ since: all.cursor - 4 })
      expect(tail.data).toBe(all.data.slice(-4))
      expect(tail.truncated).toBe(false)
      release()
    })

    it('says when the output it was asked for has already been dropped', async () => {
      const { host: h } = host({ maxCycles: 3_000_000 })
      const release = h.retainOutput()
      await h.run('turbo')

      h.readOutput({ clear: true })
      expect(h.readOutput({ since: 0 }).truncated).toBe(true)
      release()
    })

    it('reports console output to every subscriber', async () => {
      const { host: h } = host({ maxCycles: 3_000_000 })
      let seen = ''
      const off = h.onSerialOutput((data) => {
        seen += Buffer.from(data).toString('binary')
      })

      await h.run('turbo')

      expect(seen).toContain('KIM MONITOR')
      off()
    })
  })
})

describe('SerialConsole', () => {
  // Programmed as KernalInit leaves it ($09: receiver on, RTS low), so input is
  // sent from the start with flow control on, the default.
  const machine = () => {
    const m = new Machine()
    m.write(0x9002, 0x09)
    return m
  }

  describe.each([
    { flowControl: true, holds: true },
    { flowControl: false, holds: false }
  ])('with flow control $flowControl', ({ flowControl, holds }) => {
    it(holds
      ? 'sends nothing while the machine has RTS raised, and resumes at the line rate when it drops'
      : 'ignores RTS and keeps sending at the line rate, as 1.0.9 did', () => {
      const m = machine()
      m.flowControl = flowControl
      const received: number[] = []
      jest.spyOn(m.acia()!, 'onData').mockImplementation((byte: number) => received.push(byte))
      const perByte = Math.ceil((1_000_000 * 10) / 19200)

      const console_ = new SerialConsole(m, 19200)
      console_.write('ABCD')

      m.write(0x9002, 0x01) // DTR on, RTSB high
      m.runCycles(perByte)
      console_.pump()
      expect(received).toEqual(holds ? [] : [0x41])
      for (let i = 0; i < 100; i++) {
        m.runCycles(perByte)
        console_.pump()
      }

      if (!holds) {
        expect(received).toEqual([0x41, 0x42, 0x43, 0x44])
        expect(console_.pendingBytes).toBe(0)
        return
      }
      expect(received).toEqual([])
      expect(console_.pendingBytes).toBe(4)

      // The hold banked no time: the first byte still takes a byte's line time.
      m.write(0x9002, 0x09) // RTSB low
      m.runCycles(perByte - 1)
      console_.pump()
      expect(received).toEqual([])

      m.runCycles(1)
      console_.pump()
      expect(received).toEqual([0x41])

      m.runCycles(perByte * 3)
      console_.pump()
      expect(received).toEqual([0x41, 0x42, 0x43, 0x44])
    })
  })

  it('paces input at the line rate rather than delivering it at once', () => {
    const m = machine()
    const received: number[] = []
    const acia = m.acia()!
    jest.spyOn(acia, 'onData').mockImplementation((byte: number) => received.push(byte))

    const console_ = new SerialConsole(m, 19200)
    console_.write('ABCD')

    // 10 bits per byte at 19200 baud is 520.83 cycles at 1 MHz.
    const perByte = Math.ceil((1_000_000 * 10) / 19200)
    m.runCycles(perByte)
    console_.pump()
    expect(received.length).toBe(1)

    m.runCycles(perByte * 3)
    console_.pump()
    expect(received.length).toBe(4)
  })

  it('holds bytes until enough emulated time has passed', () => {
    const m = machine()
    const console_ = new SerialConsole(m, 19200)
    console_.write('AB')

    m.runCycles(100) // well under one byte time
    console_.pump()
    expect(console_.pendingBytes).toBe(2)
  })

  it('does not bank credit while idle, so a later write is still paced', () => {
    const m = machine()
    const console_ = new SerialConsole(m, 19200)

    // A long quiet stretch with nothing queued.
    m.runCycles(1_000_000)
    console_.pump()

    console_.write('ABCD')
    console_.pump()
    expect(console_.pendingBytes).toBe(4)
  })

  it('resync discards banked time, so held-back input is not released in a burst', () => {
    const m = machine()
    const console_ = new SerialConsole(m, 19200)
    console_.write('ABCD')

    // Time passes while the gate is shut and pump() is not being called.
    m.runCycles(1_000_000)
    console_.resync()
    console_.pump()

    expect(console_.pendingBytes).toBe(4)
  })
})
