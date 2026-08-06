import {
  parseEmbedParams,
  decodeBase64,
  ALL_PANELS
} from '../renderer/src/embed/params'
import type { MediaSource } from '../renderer/src/embed/params'
import { parseKeys, pressKeys, createKeyer } from '../renderer/src/embed/keys'
import { LEDLatch } from '@core/accessories/LEDLatch'

/**
 * The embed's whole configuration surface.
 *
 * Every parameter is exercised here, valid and malformed, because the embed is
 * the one entry point with no operator: a docs page writes a URL once and
 * nobody watches it again. The rule the parser is held to is that **nothing is
 * fatal** — a bad value falls back and records a warning, so an embed pinned to
 * a version that has never heard of a parameter still boots.
 *
 * `params.ts` is import-light on purpose (see its header), which is what lets
 * all of this run under the node-environment Jest setup with no DOM at all.
 */

/** The bytes a MediaSource carries, for the inline cases. */
function inlineBytes(source: MediaSource | null): number[] {
  if (!source || source.kind !== 'inline') throw new Error('expected an inline source')
  return [...source.bytes]
}

describe('decodeBase64', () => {
  it('decodes the standard alphabet, padded or not', () => {
    expect([...decodeBase64('qQFg')]).toEqual([0xa9, 0x01, 0x60])
    expect([...decodeBase64('qQFgAA==')]).toEqual([0xa9, 0x01, 0x60, 0x00])
    expect([...decodeBase64('qQFgAA')]).toEqual([0xa9, 0x01, 0x60, 0x00])
  })

  it('accepts the URL-safe alphabet and a space for +', () => {
    // 0xFB 0xFF 0xBF encodes as "+/+/" in the standard alphabet.
    expect([...decodeBase64('-_-_')]).toEqual([...decodeBase64('+/+/')])
    expect([...decodeBase64(' /+/')]).toEqual([...decodeBase64('+/+/')])
  })

  it('strips a data: prefix and embedded whitespace', () => {
    expect([...decodeBase64('data:application/octet-stream;base64,qQFg')]).toEqual([
      0xa9, 0x01, 0x60
    ])
    expect([...decodeBase64('qQ\nFg')]).toEqual([0xa9, 0x01, 0x60])
  })

  it('rejects junk rather than tolerating it', () => {
    expect(() => decodeBase64('qQ!g')).toThrow(/invalid base64 character/)
    expect(() => decodeBase64('qQ==Fg')).toThrow(/after base64 padding/)
  })
})

describe('parseEmbedParams — defaults', () => {
  it('gives a whole machine with an empty query', () => {
    const params = parseEmbedParams('')

    expect(params.rom).toBeNull()
    expect(params.binaries).toEqual([])
    expect(params.accessory).toBeNull()
    expect(params.serialCard).toBe(true)
    expect(params.autostart).toBe(true)
    expect(params.autotype).toBeNull()
    expect(params.keys).toEqual([])
    expect(params.panels).toEqual([...ALL_PANELS])
    expect(params.controls).toBe('minimal')
    expect(params.origins).toBeNull()
    expect(params.warnings).toEqual([])
  })

  it('accepts a query string with or without its leading ?', () => {
    expect(parseEmbedParams('?controls=none').controls).toBe('none')
    expect(parseEmbedParams('controls=none').controls).toBe('none')
    expect(parseEmbedParams(new URLSearchParams({ controls: 'none' })).controls).toBe('none')
  })

  it('ignores a parameter it has never heard of', () => {
    // The version-pinning case: a docs page newer than the emulator it frames.
    const params = parseEmbedParams('?cart=game.bin&freq=2&muted=0&cfsize=8')
    expect(params.warnings).toEqual([])
    expect(params.panels).toEqual([...ALL_PANELS])
  })
})

describe('rom / rom64', () => {
  it('takes a URL and labels it from the last path segment', () => {
    const { rom } = parseEmbedParams('?rom=https://example.test/roms/BIOS%20v2.bin')
    expect(rom).toEqual({
      kind: 'url',
      url: 'https://example.test/roms/BIOS v2.bin',
      label: 'BIOS v2.bin'
    })
  })

  it('takes an inline payload', () => {
    const { rom } = parseEmbedParams('?rom64=qQFg')
    expect(inlineBytes(rom)).toEqual([0xa9, 0x01, 0x60])
    expect(rom?.label).toBe('BIOS ROM (inline)')
  })

  it('prefers rom64 over rom, and says so', () => {
    const params = parseEmbedParams('?rom=https://example.test/a.bin&rom64=qQFg')
    expect(params.rom?.kind).toBe('inline')
    expect(params.warnings).toContainEqual(expect.stringContaining('using rom64'))
  })

  it('falls back to the bundled BIOS on a bad payload', () => {
    const params = parseEmbedParams('?rom64=not!base64')
    expect(params.rom).toBeNull()
    expect(params.warnings).toContainEqual(expect.stringContaining('rom64'))
  })

  it('ignores an empty value', () => {
    const params = parseEmbedParams('?rom=%20')
    expect(params.rom).toBeNull()
    expect(params.warnings).toContainEqual(expect.stringContaining('rom: empty'))
  })
})

describe('bin / bin64', () => {
  it('reads an address and a URL', () => {
    const { binaries } = parseEmbedParams('?bin=$0800=https://example.test/counter.bin')
    expect(binaries).toHaveLength(1)
    expect(binaries[0]!.address).toBe(0x0800)
    expect(binaries[0]!.source).toEqual({
      kind: 'url',
      url: 'https://example.test/counter.bin',
      label: 'counter.bin'
    })
  })

  it('takes $, 0x and decimal addresses, as the CLI does', () => {
    const { binaries } = parseEmbedParams(
      '?bin64=$0800=qQFg&bin64=0x0900=qQFg&bin64=2048=qQFg'
    )
    expect(binaries.map((b) => b.address)).toEqual([0x0800, 0x0900, 2048])
  })

  it('splits bin64 on the first = so base64 padding survives', () => {
    const { binaries } = parseEmbedParams('?bin64=$0800=qQFgAA==')
    expect(inlineBytes(binaries[0]!.source)).toEqual([0xa9, 0x01, 0x60, 0x00])
  })

  it('keeps bin and bin64 in the order they were written', () => {
    // Two writes can overlap, so whichever the author put last must land last.
    const { binaries } = parseEmbedParams(
      '?bin64=$0800=qQ&bin=$0801=https://example.test/b.bin&bin64=$0802=YA'
    )
    expect(binaries.map((b) => b.address)).toEqual([0x0800, 0x0801, 0x0802])
  })

  it('refuses an address above the top of RAM', () => {
    // $9400 is the accessory bay, not memory — a write there never lands.
    const params = parseEmbedParams('?bin64=$9400=qQFg')
    expect(params.binaries).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('$0000-$7FFF'))
  })

  it('reports a spec with no address at all', () => {
    const params = parseEmbedParams('?bin=https://example.test/b.bin')
    expect(params.binaries).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('expected <address>=<url>'))
  })

  it('reports an unparseable address', () => {
    const params = parseEmbedParams('?bin=zz=https://example.test/b.bin')
    expect(params.binaries).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('expected an address'))
  })

  it('reports an empty URL', () => {
    const params = parseEmbedParams('?bin=$0800=')
    expect(params.binaries).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('empty URL'))
  })
})

describe('accessory', () => {
  it('takes a registry id', () => {
    expect(parseEmbedParams(`?accessory=${LEDLatch.ID}`).accessory).toBe(LEDLatch.ID)
  })

  it('is case-insensitive', () => {
    expect(parseEmbedParams(`?accessory=${LEDLatch.ID.toUpperCase()}`).accessory).toBe(LEDLatch.ID)
  })

  it('leaves the bay empty for none, empty and absent', () => {
    expect(parseEmbedParams('?accessory=none').accessory).toBeNull()
    expect(parseEmbedParams('?accessory=empty').accessory).toBeNull()
    expect(parseEmbedParams('?accessory=').accessory).toBeNull()
    expect(parseEmbedParams('').accessory).toBeNull()
    expect(parseEmbedParams('?accessory=none').warnings).toEqual([])
  })

  it('names what it knows about when the id is not one of them', () => {
    const params = parseEmbedParams('?accessory=relay-board')
    expect(params.accessory).toBeNull()
    expect(params.warnings).toContainEqual(expect.stringContaining(LEDLatch.ID))
  })
})

describe('serialcard', () => {
  it('is fitted by default and pullable', () => {
    expect(parseEmbedParams('').serialCard).toBe(true)
    expect(parseEmbedParams('?serialcard=0').serialCard).toBe(false)
  })

  it('takes every spelling of a flag', () => {
    for (const yes of ['1', 'true', 'yes', 'on', '']) {
      expect(parseEmbedParams(`?serialcard=${yes}`).serialCard).toBe(true)
    }
    for (const no of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(parseEmbedParams(`?serialcard=${no}`).serialCard).toBe(false)
    }
  })

  it('falls back and warns on nonsense', () => {
    const params = parseEmbedParams('?serialcard=maybe')
    expect(params.serialCard).toBe(true)
    expect(params.warnings).toContainEqual(expect.stringContaining('serialcard'))
  })
})

describe('autostart', () => {
  it('is on by default and can be turned off', () => {
    expect(parseEmbedParams('').autostart).toBe(true)
    expect(parseEmbedParams('?autostart=0').autostart).toBe(false)
    expect(parseEmbedParams('?autostart').autostart).toBe(true)
  })

  it('falls back and warns on nonsense', () => {
    const params = parseEmbedParams('?autostart=soon')
    expect(params.autostart).toBe(true)
    expect(params.warnings).toContainEqual(expect.stringContaining('autostart'))
  })
})

describe('autotype', () => {
  it('unescapes the sequences someone writes by hand', () => {
    expect(parseEmbedParams('?autotype=0800.080F\\r').autotype).toBe('0800.080F\r')
    expect(parseEmbedParams('?autotype=a\\nb\\tc\\\\d').autotype).toBe('a\nb\tc\\d')
  })

  it('takes \\xNN, because the splash wants an ESC', () => {
    expect(parseEmbedParams('?autotype=\\x1b0800: A9 41\\r').autotype).toBe('\x1b0800: A9 41\r')
    // Uppercase digits, lowercase `x` — character for character the rule
    // `6502-kim dbg`'s `unescape` runs, so a sequence copied from one to the
    // other means the same thing.
    expect(parseEmbedParams('?autotype=\\x1B').autotype).toBe('\x1b')
    expect(parseEmbedParams('?autotype=\\X1B').autotype).toBe('\\X1B')
  })

  it('leaves an unknown escape alone rather than eating the backslash', () => {
    expect(parseEmbedParams('?autotype=C:\\path').autotype).toBe('C:\\path')
  })

  it('passes a percent-decoded control character straight through', () => {
    expect(parseEmbedParams('?autotype=%1B0800R%0D').autotype).toBe('\x1b0800R\r')
  })

  it('ignores an empty value', () => {
    const params = parseEmbedParams('?autotype=')
    expect(params.autotype).toBeNull()
    expect(params.warnings).toContainEqual(expect.stringContaining('autotype'))
  })
})

describe('keys', () => {
  it('reads names into encoder codes', () => {
    // The whole point of KeypadMap: 0 is $0A, and the code is not the value.
    expect(parseEmbedParams('?keys=0,8,0,0').keys).toEqual([0x0a, 0x08, 0x0a, 0x0a])
    expect(parseEmbedParams('?keys=ESC').keys).toEqual([0x10])
  })

  it('takes the glyph keys by word or by cap', () => {
    expect(parseEmbedParams('?keys=UP').keys).toEqual([0x14])
    expect(parseEmbedParams('?keys=RUN').keys).toEqual([0x14])
    expect(parseEmbedParams('?keys=▲').keys).toEqual([0x14])
    expect(parseEmbedParams('?keys=LEFT,RIGHT').keys).toEqual([0x00, 0x0b])
  })

  it('takes a code when it is written as hex', () => {
    expect(parseEmbedParams('?keys=$10,0x14').keys).toEqual([0x10, 0x14])
  })

  it('is case-insensitive and tolerates spacing', () => {
    expect(parseEmbedParams('?keys= esc , a , F ').keys).toEqual([0x10, 0x13, 0x0c])
  })

  it('refuses the whole sequence when one token is wrong', () => {
    // Half an address keyed into the monitor is worse than none, and much
    // harder to see afterwards.
    const params = parseEmbedParams('?keys=0,8,Q,0')
    expect(params.keys).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('no key "Q"'))
  })

  it('refuses a hex code no switch produces', () => {
    const params = parseEmbedParams('?keys=$18')
    expect(params.keys).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('code "$18"'))
  })

  it('reports an empty sequence', () => {
    const params = parseEmbedParams('?keys=,,')
    expect(params.keys).toEqual([])
    expect(params.warnings).toContainEqual(expect.stringContaining('empty'))
  })
})

describe('panels', () => {
  it('shows all four by default', () => {
    expect(parseEmbedParams('').panels).toEqual(['terminal', 'lcd', 'keys', 'accessory'])
  })

  it('shows only what was named', () => {
    expect(parseEmbedParams('?panels=lcd,keys').panels).toEqual(['lcd', 'keys'])
    expect(parseEmbedParams('?panels=terminal').panels).toEqual(['terminal'])
  })

  it('returns them in layout order, not in the order they were written', () => {
    expect(parseEmbedParams('?panels=accessory,keys,terminal,lcd').panels).toEqual([
      'terminal',
      'lcd',
      'keys',
      'accessory'
    ])
  })

  it('accepts the obvious other names for each panel', () => {
    expect(parseEmbedParams('?panels=term,display,keypad,bay').panels).toEqual([
      'terminal',
      'lcd',
      'keys',
      'accessory'
    ])
  })

  it('is case-insensitive, tolerates spacing, and de-duplicates', () => {
    expect(parseEmbedParams('?panels= LCD , keys , keypad ').panels).toEqual(['lcd', 'keys'])
  })

  it('drops a name it does not know and keeps the rest', () => {
    const params = parseEmbedParams('?panels=lcd,video')
    expect(params.panels).toEqual(['lcd'])
    expect(params.warnings).toContainEqual(expect.stringContaining('no panel called "video"'))
  })

  it('shows all four rather than nothing when none of them are recognised', () => {
    // A blank rectangle is indistinguishable from a broken embed.
    const params = parseEmbedParams('?panels=video,sid')
    expect(params.panels).toEqual([...ALL_PANELS])
    expect(params.warnings).toContainEqual(expect.stringContaining('showing all four'))
  })
})

describe('controls', () => {
  it('takes the three modes', () => {
    expect(parseEmbedParams('?controls=full').controls).toBe('full')
    expect(parseEmbedParams('?controls=minimal').controls).toBe('minimal')
    expect(parseEmbedParams('?controls=NONE').controls).toBe('none')
  })

  it('falls back to minimal and warns', () => {
    const params = parseEmbedParams('?controls=some')
    expect(params.controls).toBe('minimal')
    expect(params.warnings).toContainEqual(expect.stringContaining('controls'))
  })
})

describe('origins', () => {
  it('is any by default', () => {
    expect(parseEmbedParams('').origins).toBeNull()
  })

  it('reads a comma-separated list', () => {
    expect(parseEmbedParams('?origins=https://a.test, https://b.test').origins).toEqual([
      'https://a.test',
      'https://b.test'
    ])
  })

  it('treats * and an empty list as any', () => {
    expect(parseEmbedParams('?origins=*').origins).toBeNull()
    expect(parseEmbedParams('?origins=https://a.test,*').origins).toBeNull()
    expect(parseEmbedParams('?origins=').origins).toBeNull()
  })
})

describe('several parameters at once', () => {
  it('reads the LED demo the DOCS card describes', () => {
    const params = parseEmbedParams(
      `?bin64=$0800=qQFg&accessory=${LEDLatch.ID}&panels=lcd,keys,accessory` +
        '&keys=ESC,0,8,0,0,RIGHT,UP&controls=full&serialcard=0'
    )

    expect(params.binaries).toHaveLength(1)
    expect(params.accessory).toBe(LEDLatch.ID)
    expect(params.panels).toEqual(['lcd', 'keys', 'accessory'])
    expect(params.keys).toEqual([0x10, 0x0a, 0x08, 0x0a, 0x0a, 0x0b, 0x14])
    expect(params.controls).toBe('full')
    expect(params.serialCard).toBe(false)
    expect(params.warnings).toEqual([])
  })

  it('collects every warning and still returns a usable machine', () => {
    const params = parseEmbedParams(
      '?rom64=!!&bin=nope&accessory=relay&panels=video&keys=Q&controls=some&autostart=perhaps'
    )

    // Eight, not seven: `panels` reports the name it did not know *and* that it
    // fell back to showing everything, which are two different things to fix.
    expect(params.warnings).toHaveLength(8)
    // Everything fell back to its default, which is a machine that boots.
    expect(params.rom).toBeNull()
    expect(params.binaries).toEqual([])
    expect(params.accessory).toBeNull()
    expect(params.panels).toEqual([...ALL_PANELS])
    expect(params.keys).toEqual([])
    expect(params.controls).toBe('minimal')
    expect(params.autostart).toBe(true)
  })
})

describe('parseKeys', () => {
  it('reads a bare number as a name, never as a code', () => {
    // `key 0` presses the zero key, which reports $0A. Reading it as a code
    // would press ◄ — see KeypadMap, and the CLI's `key` command.
    expect(parseKeys('0').codes).toEqual([0x0a])
    expect(parseKeys('$00').codes).toEqual([0x00])
  })

  it('reads C-F, which run backwards', () => {
    expect(parseKeys('C,D,E,F').codes).toEqual([0x0f, 0x0e, 0x0d, 0x0c])
  })

  it('names the pad in its error, so a mistyped key is fixable', () => {
    expect(parseKeys('Z').error).toContain('PGUP')
  })
})

describe('pressKeys', () => {
  it('presses in order, and one at a time', async () => {
    const pressed: number[] = []
    await pressKeys([0x10, 0x0a], (code) => pressed.push(code), { kps: 1000 })
    expect(pressed).toEqual([0x10, 0x0a])
  })

  it('stops when the caller says to', async () => {
    const pressed: number[] = []
    await pressKeys(
      [0x01, 0x02, 0x03],
      (code) => pressed.push(code),
      { kps: 1000, cancelled: () => pressed.length >= 2 }
    )
    expect(pressed).toEqual([0x01, 0x02])
  })
})

describe('createKeyer', () => {
  it('lets a second sequence take the pad from the first', async () => {
    // Two sequences pacing against one 74C922 would interleave, and interleaved
    // presses are lost rather than reordered: the encoder holds one code.
    const pressed: number[] = []
    const keyer = createKeyer((code) => pressed.push(code))

    const first = keyer.play([0x01, 0x02, 0x03], 200)
    await new Promise((resolve) => setTimeout(resolve, 1))
    const second = keyer.play([0x0a], 200)
    await Promise.all([first, second])

    expect(pressed).toEqual([0x01, 0x0a])
  })

  it('cancel() abandons what is in flight', async () => {
    const pressed: number[] = []
    const keyer = createKeyer((code) => pressed.push(code))

    const playing = keyer.play([0x01, 0x02, 0x03], 200)
    await new Promise((resolve) => setTimeout(resolve, 1))
    keyer.cancel()
    await playing

    expect(pressed).toEqual([0x01])
  })
})
