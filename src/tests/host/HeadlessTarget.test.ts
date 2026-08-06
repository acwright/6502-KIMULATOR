import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessHost } from '../../host/headless/HeadlessHost'
import { HeadlessTarget } from '../../host/headless/HeadlessTarget'
import { CardROM } from '../../core/CardROM'
import { createMethods } from '../../debug/server/Methods'
import { ErrorCode, RpcMethodError } from '../../debug/server/Protocol'
import { parseSymbols } from '../../debug/symbols/parse'

/**
 * What the headless host tells the debug protocol it can do.
 *
 * The interesting half is what it says it *cannot*: a KIM with no Serial Card
 * has no console at all, and the target leaves those methods off rather than
 * wiring them to something that would accept bytes and drop them.
 */

/** A machine that runs a NOP sled from $E000, so tests need no real firmware. */
function host(options: { serialCard?: boolean } = {}): HeadlessHost {
  const card = new Uint8Array(CardROM.SIZE).fill(0xea)
  card[0xfffc - CardROM.START] = 0x00
  card[0xfffd - CardROM.START] = 0xe0

  return new HeadlessHost({
    rom: new Uint8Array(0x8000).fill(0xea),
    cardROM: card,
    ...(options.serialCard === false ? { serialCard: false } : {})
  })
}

describe('with the Serial Card fitted', () => {
  it('reports a serial console and carries bytes both ways', () => {
    const h = host()
    const target = new HeadlessTarget(h, '9.9.9')

    expect(target.consoleMode()).toBe('serial')
    expect(target.baudRate!()).toBe(19200)

    target.setBaudRate!(9600)
    expect(h.serial!.baudRate).toBe(9600)

    target.writeSerial!(Uint8Array.of(0x41))
    expect(h.serial!.pendingBytes).toBe(1)
  })

  /**
   * The target retains output for the whole of its life, because something is
   * going to ask for `serial.read` and the host keeps nothing otherwise.
   */
  it('retains console output from the moment it is constructed', async () => {
    const h = host()
    const target = new HeadlessTarget(h, '9.9.9')

    h.session.machine.transmit!(0x4b)
    expect(target.readSerial!({}).data).toBe('K')

    let seen = ''
    const off = target.onSerial!((text) => {
      seen += text
    })
    h.session.machine.transmit!(0x49)
    off()
    expect(seen).toBe('I')
  })
})

describe('with the Serial Card pulled', () => {
  it('reports a keypad console and offers no serial path at all', () => {
    const target = new HeadlessTarget(host({ serialCard: false }), '9.9.9')

    expect(target.consoleMode()).toBe('keypad')
    expect(target.writeSerial).toBeUndefined()
    expect(target.readSerial).toBeUndefined()
    expect(target.onSerial).toBeUndefined()
    expect(target.baudRate).toBeUndefined()
    expect(target.setBaudRate).toBeUndefined()
  })

  /**
   * Which the method table turns into NOT_SUPPORTED — a truthful thing for a
   * client to hear about a machine it can still drive from the pad and read off
   * the LCD.
   */
  it('answers the serial methods with NOT_SUPPORTED, and the rest normally', async () => {
    const methods = createMethods(new HeadlessTarget(host({ serialCard: false }), '9.9.9'))

    let error: RpcMethodError | undefined
    try {
      await methods['serial.write']!({ data: 'X' })
    } catch (e) {
      error = e as RpcMethodError
    }
    expect(error?.code).toBe(ErrorCode.NOT_SUPPORTED)

    expect(methods['session.info']!({})).toMatchObject({
      console: 'keypad',
      serialCard: false
    })
    expect((methods['lcd.text']!({}) as { lines: string[] }).lines).toHaveLength(2)
  })
})

describe('driving one from the protocol', () => {
  /**
   * The phase's exit criterion: a breakpoint set in the Keypad Card's ROM by
   * name. The symbols the host loaded and the ones a `sym.load` adds are one
   * table — owned by the host — which is what lets `--symbols` on the command
   * line and a later call agree about where `KcMain` is.
   */
  it('sets a breakpoint in the card ROM by symbol name, and stops there', async () => {
    const h = host()
    const dir = mkdtempSync(join(tmpdir(), '6502-kim-symbols-'))
    const path = join(dir, 'KC Monitor.lbl')
    writeFileSync(path, 'al C:E010 .KcMain\n')

    h.symbols.merge(parseSymbols(readFileSync(path, 'utf8'), 'vice', path))
    h.session.symbolResolver = (name) => h.symbols.resolve(name)

    const methods = createMethods(new HeadlessTarget(h, '9.9.9'))
    const set = (await methods['bp.set']!({ address: 'KcMain' })) as { address: number }
    expect(set.address).toBe(0xe010)

    const stop = (await methods['exec.runTo']!({ address: 'KcMain' })) as {
      stop: { kind: string; address: number }
    }
    expect(stop.stop).toMatchObject({ kind: 'breakpoint', address: 0xe010 })
    expect(h.session.machine.cpu.pc).toBe(0xe010)
  })

  it('shutdown ends the run rather than leaving the process holding it', async () => {
    const h = host()
    const target = new HeadlessTarget(h, '9.9.9')

    const pending = h.run('turbo')
    target.shutdown()

    expect((await pending).reason).toBe('stopped')
  })
})
