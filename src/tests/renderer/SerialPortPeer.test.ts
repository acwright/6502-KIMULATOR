import { Machine } from '../../core/Machine'
import { ACIA } from '../../core/IO/ACIA'
import { SerialPortPeer } from '../../renderer/src/services/serialPortPeer'
import type { SerialSignals } from '../../shared/types'

/**
 * A real host serial port as the far end of the machine's serial card.
 *
 * While it is connected the machine's RTS drives the port's RTS line, and the
 * port's CTS, DCD and DSR reach the chip wherever the card's jumpers connect
 * those pins to the cable. Disconnected, nothing is on the cable to drop a
 * line, and the chip sees them asserted as it always has.
 */

let machine: Machine | null = null

const service = {
  rts: [] as boolean[],
  signals: undefined as ((s: SerialSignals) => void) | undefined,
  onSignals: (cb: (s: SerialSignals) => void) => {
    service.signals = cb
    return () => {}
  },
  setRequestToSend: (asserted: boolean) => service.rts.push(asserted)
}

const peer = new SerialPortPeer(service, () => machine)

function acia(machine: Machine): ACIA {
  return machine.io5 as ACIA
}

beforeEach(() => {
  jest.useFakeTimers()
  service.rts = []
  machine = new Machine()
  // The Pro with DCD Select on the cable: CTS, DCD and DSR all follow it.
  machine.serialCard = { card: 'pro', jumpers: { dcd: 'cable' } }
})

afterEach(() => {
  peer.stop()
  jest.useRealTimers()
})

describe('a host serial port as the far end of the cable', () => {
  it('drives the port\'s RTS from the machine as soon as it connects, and as RTS moves', () => {
    peer.start()
    expect(service.rts).toEqual([false]) // reset: TIC 00, RTS high

    machine!.write(0x9002, 0x09) // DTR on, TIC 10: RTS low
    jest.advanceTimersByTime(2)
    machine!.write(0x9002, 0x01) // TIC 00: RTS high
    jest.advanceTimersByTime(2)

    expect(service.rts).toEqual([false, true, false])
  })

  it('carries the port\'s lines to the pins the jumpers connect, and lets them go on disconnect', () => {
    peer.start()

    service.signals?.({ cts: false, dcd: false, dsr: false })
    expect(acia(machine!).pinAsserted('cts')).toBe(false)
    expect(acia(machine!).pinAsserted('dcd')).toBe(false)
    expect(acia(machine!).receiverEnabled).toBe(false)

    peer.stop()
    expect(acia(machine!).pinAsserted('cts')).toBe(true)
    expect(acia(machine!).pinAsserted('dcd')).toBe(true)
  })

  it('changes nothing at the chip on the Serial Card with CTS EN at ground', () => {
    machine!.serialCard = { card: 'standard', jumpers: {} }
    peer.start()
    service.signals?.({ cts: false, dcd: false, dsr: false })

    // CTS EN at ground; DCD and DSR tied to ground on this card.
    expect(acia(machine!).pinAsserted('cts')).toBe(true)
    expect(acia(machine!).pinAsserted('dcd')).toBe(true)
    expect(acia(machine!).pinAsserted('dsr')).toBe(true)
  })

  it('still reaches DSR on the Pro with DCD Select at ground, where it gates nothing', () => {
    machine!.serialCard = { card: 'pro', jumpers: {} }
    machine!.write(0x9002, 0x09) // DTR on, TIC 10
    peer.start()
    service.signals?.({ cts: true, dcd: false, dsr: false })

    expect(acia(machine!).pinAsserted('dcd')).toBe(true)
    expect(acia(machine!).pinAsserted('dsr')).toBe(false)
    expect(acia(machine!).receiverEnabled).toBe(true)
  })

  it('follows a new machine, as after fitting a card or wiring an accessory', () => {
    peer.start()
    service.signals?.({ cts: false, dcd: true, dsr: true })

    machine = new Machine()
    machine.serialCard = { card: 'standard', jumpers: { cts: 'cable' } }
    jest.advanceTimersByTime(2)

    expect(acia(machine).pinAsserted('cts')).toBe(false)
    expect(service.rts).toEqual([false, false])
  })
})
