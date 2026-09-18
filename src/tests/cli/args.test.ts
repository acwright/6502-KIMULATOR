import {
  UsageError,
  parseAccessory,
  parseAddress,
  parseBinarySpec,
  parseByte,
  parseCount,
  parseDuration,
  parseFlowControlFlags,
  parseSerialCardFlags,
  parseSerialFraming
} from '../../cli/args'

/**
 * The command line is where a mistake should be caught, so every one of these
 * refuses rather than coercing. 6502-EMULATOR's `parseClock` and
 * `parseFrequency` have no counterparts here: this machine has no clock card to
 * pin and one clock speed to choose from.
 */

describe('parseAddress', () => {
  it('reads the three ways a 6502 programmer writes one', () => {
    expect(parseAddress('$0800')).toBe(0x0800)
    expect(parseAddress('0xE000')).toBe(0xe000)
    expect(parseAddress('2048')).toBe(2048)
  })

  it('refuses anything outside the address space, naming the flag', () => {
    expect(() => parseAddress('$10000', '--bin')).toThrow(/^--bin:/)
    expect(() => parseAddress('-1')).toThrow(UsageError)
    expect(() => parseAddress('main')).toThrow(UsageError)
  })
})

describe('parseBinarySpec', () => {
  it('splits an address from the file to put there', () => {
    expect(parseBinarySpec('0x0800=counter.bin')).toEqual({ address: 0x0800, path: 'counter.bin' })
  })

  it('keeps a path containing an = sign intact after the first one', () => {
    expect(parseBinarySpec('$0800=a=b.bin').path).toBe('a=b.bin')
  })

  it('refuses a spec with no address', () => {
    expect(() => parseBinarySpec('counter.bin')).toThrow(/expected <address>=<file>/)
  })
})

describe('parseByte', () => {
  it('takes zero as a value, not an omission', () => {
    // `mem fill … 0` is the most common fill there is, so this must not borrow
    // parseCount's "positive number" rule.
    expect(parseByte('0', 'value')).toBe(0)
  })

  it('reads hex and decimal', () => {
    expect(parseByte('$EA', 'value')).toBe(0xea)
    expect(parseByte('0xea', 'value')).toBe(0xea)
    expect(parseByte('255', 'value')).toBe(255)
  })

  it('refuses anything that is not a byte', () => {
    expect(() => parseByte('256', 'value')).toThrow(UsageError)
    expect(() => parseByte('$1FF', 'value')).toThrow(UsageError)
    expect(() => parseByte('nope', 'value')).toThrow(UsageError)
  })
})

describe('parseCount', () => {
  it('accepts the two ways a cycle budget gets written', () => {
    expect(parseCount('10_000_000', '--max-cycles')).toBe(10_000_000)
    expect(parseCount('5e6', '--max-cycles')).toBe(5_000_000)
  })

  it('refuses zero and nonsense', () => {
    expect(() => parseCount('0', '--max-cycles')).toThrow(UsageError)
    expect(() => parseCount('soon', '--max-cycles')).toThrow(/^--max-cycles:/)
  })
})

describe('parseDuration', () => {
  it('reads bare seconds and every suffix', () => {
    expect(parseDuration('30', '--timeout')).toBe(30_000)
    expect(parseDuration('500ms', '--timeout')).toBe(500)
    expect(parseDuration('5m', '--timeout')).toBe(300_000)
  })

  it('refuses a unit it does not know', () => {
    expect(() => parseDuration('5h', '--timeout')).toThrow(/like 30s, 500ms or 5m/)
  })
})

describe('parseSerialFraming', () => {
  it('reads framing the way a terminal program writes it', () => {
    expect(parseSerialFraming('8N1', '--serial-config')).toEqual({
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    expect(parseSerialFraming('7e2', '--serial-config')).toEqual({
      dataBits: 7,
      parity: 'even',
      stopBits: 2
    })
  })

  it('refuses a framing no line could have', () => {
    expect(() => parseSerialFraming('9Z3', '--serial-config')).toThrow(/like 8N1/)
  })
})

describe('parseAccessory', () => {
  it('accepts an id the registry has', () => {
    expect(parseAccessory('led-latch')).toBe('led-latch')
  })

  /**
   * The machine leaves the bay empty for an id it does not know, which is right
   * for a settings file written by a later version and wrong for a command
   * line: a run that silently proves nothing is worse than one that fails.
   */
  it('refuses one it does not, and lists what there is', () => {
    expect(() => parseAccessory('leds')).toThrow(/no accessory "leds"/)
    expect(() => parseAccessory('leds')).toThrow(/led-latch/)
  })
})

/**
 * `--serial-card`, `--cts`, `--dcd`: the card in io5 and its jumper, from the
 * COB schematics. A jumper belongs to a card, so one the card lacks is refused
 * — the Serial Card's DCD is tied to ground, the Pro's CTS always reaches the
 * cable — rather than quietly dropped. And the ACE is refused by name: its
 * R6551 is on the ACE board, not a card a KIM can take.
 */
describe('parseSerialCardFlags', () => {
  it('says nothing when no flag is given', () => {
    expect(parseSerialCardFlags({})).toBeUndefined()
    expect(parseSerialCardFlags({ 'no-serial-card': true })).toBeUndefined()
  })

  it('fits each card with its own jumper at ground unless told otherwise', () => {
    expect(parseSerialCardFlags({ 'serial-card': 'standard' })).toEqual({
      card: 'standard',
      jumpers: { cts: 'ground' }
    })
    expect(parseSerialCardFlags({ 'serial-card': ' Pro ' })).toEqual({ card: 'pro', jumpers: { dcd: 'ground' } })
    expect(parseSerialCardFlags({ 'serial-card': 'pro', dcd: 'cable' })).toEqual({
      card: 'pro',
      jumpers: { dcd: 'cable' }
    })
  })

  it('puts a jumper with no card on the default card, the Serial Card', () => {
    expect(parseSerialCardFlags({ cts: 'cable' })).toEqual({ card: 'standard', jumpers: { cts: 'cable' } })
  })

  it('refuses a jumper the card does not have, and says why', () => {
    expect(() => parseSerialCardFlags({ 'serial-card': 'pro', cts: 'cable' })).toThrow(
      '--cts: the Serial Card Pro has no CTS jumper — its CTS always reaches the cable'
    )
    expect(() => parseSerialCardFlags({ dcd: 'ground' })).toThrow(
      '--dcd: the Serial Card has no DCD jumper — its DCD is tied to ground'
    )
  })

  it('refuses the ACE by name, and never falls back to another card', () => {
    for (const ace of ['ace', 'ACE', ' Ace ']) {
      expect(() => parseSerialCardFlags({ 'serial-card': ace })).toThrow(UsageError)
      expect(() => parseSerialCardFlags({ 'serial-card': ace })).toThrow(
        '--serial-card ace: the ACE\'s serial is on the ACE board, and cannot be fitted to a KIM'
      )
    }
  })

  it('refuses a card or a position it does not know', () => {
    expect(() => parseSerialCardFlags({ 'serial-card': 'kim' })).toThrow(
      '--serial-card: expected "standard" or "pro", got "kim"'
    )
    expect(() => parseSerialCardFlags({ cts: 'off' })).toThrow('--cts: expected "ground" or "cable", got "off"')
  })

  it('refuses any of them with --no-serial-card, which leaves io5 vacant', () => {
    expect(() => parseSerialCardFlags({ 'no-serial-card': true, 'serial-card': 'pro', dcd: 'cable' })).toThrow(
      '--serial-card, --dcd: describes the card in io5, and --no-serial-card leaves io5 vacant'
    )
  })
})

/**
 * `--peer-rts honour|ignore`, and the deprecated `--[no-]flow-control` that
 * says the same, which still works.
 */
describe('parseFlowControlFlags', () => {
  it.each([
    [{}, undefined],
    [{ 'peer-rts': 'honour' }, true],
    [{ 'peer-rts': 'honor' }, true],
    [{ 'peer-rts': 'IGNORE' }, false],
    [{ 'flow-control': true }, true],
    [{ 'no-flow-control': true }, false],
    [{ 'peer-rts': 'ignore', 'no-flow-control': true }, false]
  ] as const)('reads %j as %s', (values, expected) => {
    expect(parseFlowControlFlags(values)).toBe(expected)
  })

  it('refuses a value it does not know, and flags that disagree', () => {
    expect(() => parseFlowControlFlags({ 'peer-rts': 'on' })).toThrow(
      '--peer-rts: expected "honour" or "ignore", got "on"'
    )
    expect(() => parseFlowControlFlags({ 'peer-rts': 'honour', 'no-flow-control': true })).toThrow(
      '--peer-rts honour and --no-flow-control say opposite things'
    )
  })
})
