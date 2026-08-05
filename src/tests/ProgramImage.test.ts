import { loadBinary } from '../core/ProgramImage'
import type { MemoryBus } from '../core/ProgramImage'

/** Flat 64K memory standing in for Machine's bus. */
class FakeBus implements MemoryBus {
  readonly mem = new Uint8Array(0x10000)
  read(address: number): number {
    return this.mem[address]!
  }
  write(address: number, data: number): void {
    this.mem[address] = data & 0xff
  }
}

describe('loadBinary', () => {
  it('writes bytes at the requested address', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x2000, Uint8Array.from([1, 2, 3]))).toBe('ok')
    expect(Array.from(bus.mem.slice(0x2000, 0x2003))).toEqual([1, 2, 3])
  })

  it('allows zero page and the Kernal workspace, as BLOAD does', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x0000, Uint8Array.from([0xff]))).toBe('ok')
    expect(bus.mem[0x0000]).toBe(0xff)
  })

  it('loads the type-in cards at $0800, where they are keyed in', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x0800, Uint8Array.from([0xa9, 0x00, 0x8d, 0x00, 0x94]))).toBe('ok')
    expect(Array.from(bus.mem.slice(0x0800, 0x0805))).toEqual([0xa9, 0x00, 0x8d, 0x00, 0x94])
  })

  it('refuses to run past the top of RAM into I/O', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x7fff, Uint8Array.from([1, 2]))).toBe('out-of-range')
    expect(bus.mem[0x7fff]).toBe(0x00)
  })

  it('accepts a binary ending exactly at the top of RAM', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x7ffe, Uint8Array.from([1, 2]))).toBe('ok')
  })

  it('rejects a negative address', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, -1, Uint8Array.from([1]))).toBe('out-of-range')
  })

  it('rejects an empty file', () => {
    const bus = new FakeBus()
    expect(loadBinary(bus, 0x2000, new Uint8Array(0))).toBe('empty')
  })
})
