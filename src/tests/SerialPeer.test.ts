/**
 * The far end of the serial cable: the peer, and the link that carries the
 * machine's RTS out to it and its CTS, DCD and DSR back in.
 *
 * The headless half boots the real bundled BIOS and KC Monitor over a serial
 * console, as HeadlessHost.test.ts does, and is the proof the RTS/CTS plan
 * asks for: with `CTS EN` on the cable, a console that drops CTS holds the
 * machine silent — no banner, nothing — and with it at ground the same console
 * changes nothing. What comes back afterwards is the KC Monitor's business,
 * not the chip's; see the test that says so.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { Machine, DEFAULT_SERIAL_CARD as MACHINE_DEFAULT } from '../core/Machine'
import { ACIA } from '../core/IO/ACIA'
import { Empty } from '../core/IO/Empty'
import { LINES_ASSERTED, SerialLink } from '../core/SerialPeer'
import type { SerialLines, SerialPeer } from '../core/SerialPeer'
import { HeadlessHost } from '../host/headless/HeadlessHost'
import type { HeadlessOptions } from '../host/headless/HeadlessHost'
import { HeadlessTarget } from '../host/headless/HeadlessTarget'
import { createMethods } from '../debug/server/Methods'
import { DEFAULT_SERIAL_CARD } from '../shared/serialCard'

const ROOT = join(__dirname, '../..')
const BIOS = new Uint8Array(readFileSync(join(ROOT, 'assets/roms/BIOS.bin')))
const KC_MONITOR = new Uint8Array(readFileSync(join(ROOT, 'assets/roms/KCMonitor.bin')))

/** Enough to get through `LcdInit`'s delays and print the banner; see HeadlessHost.test.ts. */
const BOOT_BUDGET = 6_000_000

jest.setTimeout(60_000)

/** A peer that records the RTS it is given. */
class RecordingPeer implements SerialPeer {
  rts: boolean[] = []
  lines: SerialLines = { ...LINES_ASSERTED }
  receiveRequestToSend(asserted: boolean): void {
    this.rts.push(asserted)
  }
}

function acia(machine: Machine): ACIA {
  return machine.io5 as ACIA
}

describe('SerialLink', () => {
  it('gives the peer the machine\'s RTS once, then only when it changes', () => {
    const machine = new Machine()
    const peer = new RecordingPeer()
    const link = new SerialLink(peer)

    link.sync(machine) // reset: TIC 00, RTS high
    link.sync(machine)
    machine.write(0x9002, 0x09) // DTR on, TIC 10: RTS low
    link.sync(machine)
    link.sync(machine)
    machine.write(0x9002, 0x01) // TIC 00: RTS high again
    link.sync(machine)

    expect(peer.rts).toEqual([false, true, false])
  })

  it('carries the peer\'s lines to the chip, only when they change', () => {
    const machine = new Machine()
    machine.serialCard = { card: 'pro', jumpers: { dcd: 'cable' } }
    const peer = new RecordingPeer()
    const link = new SerialLink(peer)
    const setLines = jest.spyOn(machine, 'setSerialLines')

    link.sync(machine)
    link.sync(machine)
    peer.lines = { cts: false, dcd: true, dsr: false }
    link.sync(machine)
    link.sync(machine)

    expect(setLines.mock.calls.map(([lines]) => lines)).toEqual([
      { cts: true, dcd: true, dsr: true },
      { cts: false, dcd: true, dsr: false }
    ])
    expect(acia(machine).pinAsserted('cts')).toBe(false)
    expect(acia(machine).pinAsserted('dsr')).toBe(false)
  })

  it('starts afresh on a new machine, which knows nothing of the old one\'s lines', () => {
    const peer = new RecordingPeer()
    peer.lines = { cts: false, dcd: true, dsr: true }
    const link = new SerialLink(peer)
    const first = new Machine()
    first.serialCard = { card: 'pro', jumpers: {} }
    link.sync(first)

    const second = new Machine()
    second.serialCard = { card: 'pro', jumpers: {} }
    link.sync(second)

    expect(peer.rts).toEqual([false, false])
    expect(acia(second).cableLine('cts')).toBe(false)
  })

  it('reads RTS as not asserted on a keypad-only machine, which drives nothing', () => {
    expect(new Machine({ io5: new Empty() }).requestToSend).toBe(false)
  })
})

describe('the app and the machine agree on the default card', () => {
  it('is the Serial Card with CTS EN at ground in both places', () => {
    expect(DEFAULT_SERIAL_CARD).toEqual(MACHINE_DEFAULT)
  })
})

describe('a headless console as the far end of the cable', () => {
  function boot(options: Partial<HeadlessOptions> = {}) {
    let output = ''
    const host = new HeadlessHost({
      rom: BIOS,
      cardROM: KC_MONITOR,
      maxCycles: BOOT_BUDGET,
      onOutput: (data) => {
        output += Buffer.from(data).toString('binary')
      },
      ...options
    })
    return { host, read: () => output }
  }

  it('fits the Serial Card with CTS EN at ground unless told otherwise', () => {
    expect(boot().host.serialCardConfig).toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
  })

  it('silences the machine from reset when CTS EN is on the cable and the console drops CTS', async () => {
    const { host, read } = boot({
      serialCardConfig: { card: 'standard', jumpers: { cts: 'cable' } },
      serialLines: { cts: false }
    })
    await host.run('turbo')
    expect(read()).toBe('')
    // The first byte is held in the data register, and TDRE stays clear.
    expect(host.session.machine.read(0x9001) & 0x10).toBe(0)
  })

  it('silences the Serial Card Pro the same way, whose CTS always reaches the cable', async () => {
    const { host, read } = boot({
      serialCardConfig: { card: 'pro', jumpers: {} },
      serialLines: { cts: false }
    })
    await host.run('turbo')
    expect(read()).toBe('')
  })

  it('changes nothing when CTS EN is at ground, whatever the console does with its lines', async () => {
    const { host, read } = boot({ serialLines: { cts: false, dcd: false, dsr: false } })
    await host.run('turbo')
    expect(read()).toContain('KIM MONITOR')
  })

  /**
   * Where the KIM parts company with the bench. The bench ran BIOS 1.6, whose
   * `Chrout` blocks on TDRE, so a held machine printed its whole banner the
   * moment CTS came back. The KC Monitor's `SerPutc` does not block: it waits
   * about 27 ms for TDRE and then drops the byte, so that the keypad monitor
   * stays alive with no terminal attached (`KC Monitor.asm`, `SerPutc`).
   *
   * So with CTS held off, the first byte goes into the one-deep data register
   * and waits there, and every byte after it is dropped by the firmware — not
   * by the chip, which is doing exactly what the bench measured. On release
   * that one byte goes out, and the monitor answers the next thing it is sent
   * as if nothing had happened. The machine went mute, not dead.
   */
  it('goes mute with the KC Monitor, which drops what it cannot send, and answers once CTS is back', async () => {
    const { host, read } = boot({
      serialCardConfig: { card: 'standard', jumpers: { cts: 'cable' } },
      serialLines: { cts: false },
      maxCycles: 20_000_000
    })
    host.session.runCycles(BOOT_BUDGET)
    expect(read()).toBe('')
    // Alive the whole time: the splash is on the glass.
    expect(host.lcdText()).toEqual(['KIM MONITOR v1.0', '--ESC TO START--'])

    host.setSerialLines({ cts: true })
    host.write('\x1b0800: A9 41 EA\r0800.0802\r')
    await host.run('turbo')

    // The held CR, then the monitor answering; the banner itself is gone.
    expect(read()).toMatch(/^\r\r\n> 0800: A9 41 EA\r\n/)
    expect(read()).not.toContain('KIM MONITOR')
    expect(read()).toMatch(/0800: A9 41 EA\r\n> $/)
    expect(host.session.machine.peek(0x0800)).toBe(0xa9)
  })

  it('shows and moves the lines over the debug protocol', () => {
    const { host } = boot({ serialCardConfig: { card: 'pro', jumpers: { dcd: 'cable' } } })
    const methods = createMethods(new HeadlessTarget(host, 'test'))

    expect(methods['session.info']!({})).toMatchObject({
      serialCard: true,
      serialCardConfig: { card: 'pro', jumpers: { dcd: 'cable' } }
    })
    expect(methods['serial.lines']!({ dcd: false, dsr: false })).toEqual({
      rts: false,
      lines: { cts: true, dcd: false, dsr: false },
      pins: {
        cts: { wiring: 'cable', asserted: true },
        dcd: { wiring: 'cable', asserted: false },
        dsr: { wiring: 'cable', asserted: false }
      }
    })
    // The status register follows the pins: DCD and DSR high read as bits 5 and 6.
    expect(host.session.machine.read(0x9001) & 0x60).toBe(0x60)
  })

  it('has no lines to show on a keypad-only machine', () => {
    const { host } = boot({ serialCard: false })
    const methods = createMethods(new HeadlessTarget(host, 'test'))

    expect(methods['session.info']!({})).toMatchObject({ serialCard: false, serialCardConfig: null })
    expect(() => methods['serial.lines']!({})).toThrow(/no serial card/)
  })
})
