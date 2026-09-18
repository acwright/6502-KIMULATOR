import { runCommand } from '../../cli/run'
import { HeadlessHost } from '../../host/headless/HeadlessHost'

jest.setTimeout(60_000)

describe('run --flow-control / --no-flow-control', () => {
  it('is in the help, deprecated in favour of --peer-rts, which says it is on by default', async () => {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    try {
      expect(await runCommand(['--help'])).toBe(0)
    } finally {
      out.mockRestore()
    }
    expect(chunks.join('')).toMatch(/--peer-rts <honour\|ignore>\s+Whether the console holds its input while the machine\s+raises RTS \(default: honour\)/)
    expect(chunks.join('')).toMatch(/--flow-control +Deprecated: --peer-rts honour/)
    expect(chunks.join('')).toMatch(/--no-flow-control +Deprecated: --peer-rts ignore/)
    expect(chunks.join('')).toMatch(/--serial-card <standard\|pro>\n/)
  })

  it.each([
    [['--flow-control'], true],
    [[], true],
    [['--no-flow-control'], false]
  ] as const)('has flow control on for a headless run unless --no-flow-control is given (%j)', async (flag, on) => {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    const hosts = jest.spyOn(HeadlessHost.prototype, 'run')
    try {
      expect(await runCommand(['--headless', '--max-cycles', '1000', ...flag])).toBe(0)
      expect((hosts.mock.contexts[0] as HeadlessHost).flowControl).toBe(on)
    } finally {
      hosts.mockRestore()
      out.mockRestore()
      err.mockRestore()
    }
    expect(chunks.join('')).toContain(`serial console, 1 MHz${on ? '' : ', no flow control'}, turbo`)
  })

  it('refuses both flags at once', async () => {
    await expect(runCommand(['--headless', '--flow-control', '--no-flow-control'])).rejects.toThrow(
      '--flow-control and --no-flow-control cannot both be given'
    )
  })
})

describe('run --serial-card / --cts / --dcd', () => {
  async function headless(flags: string[]): Promise<{ host: HeadlessHost; err: string }> {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    const hosts = jest.spyOn(HeadlessHost.prototype, 'run')
    try {
      expect(await runCommand(['--headless', '--max-cycles', '1000', ...flags])).toBe(0)
      return { host: hosts.mock.contexts[0] as HeadlessHost, err: chunks.join('') }
    } finally {
      hosts.mockRestore()
      out.mockRestore()
      err.mockRestore()
    }
  }

  it('fits the Serial Card with CTS EN at ground, and the banner says nothing about it', async () => {
    const { host, err } = await headless([])
    expect(host.serialCardConfig).toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
    expect(err).toContain('serial console, 1 MHz, turbo')
  })

  it('fits the card asked for, and the banner names it and its jumper', async () => {
    const { host, err } = await headless(['--serial-card', 'pro', '--dcd', 'cable'])
    expect(host.serialCardConfig).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
    expect(err).toContain('serial console, 1 MHz, Serial Card Pro (DCD Select: cable), turbo')
  })

  it('refuses a jumper the card lacks before booting', async () => {
    await expect(runCommand(['--headless', '--dcd', 'cable'])).rejects.toThrow(
      '--dcd: the Serial Card has no DCD jumper — its DCD is tied to ground'
    )
  })

  /**
   * The ACE's serial is on the ACE board. The plan (RTSCTS-PLAN D1) makes this
   * a usage error rather than a silent fallback, and pins it with a test,
   * because the obvious way to port 6502-EMULATOR's parser is to copy all three.
   */
  it('refuses --serial-card ace as a card that cannot be fitted to a KIM', async () => {
    await expect(runCommand(['--headless', '--serial-card', 'ace'])).rejects.toThrow(
      /^--serial-card ace: the ACE's serial is on the ACE board, and cannot be fitted to a KIM/
    )
    await expect(runCommand(['--serial-card', 'ace'])).rejects.toThrow(/cannot be fitted to a KIM/)
  })

  it('refuses a card for an io5 that --no-serial-card leaves vacant', async () => {
    await expect(runCommand(['--headless', '--no-serial-card', '--serial-card', 'pro'])).rejects.toThrow(
      /--no-serial-card leaves io5 vacant/
    )
  })

  it('takes --peer-rts ignore as --no-flow-control', async () => {
    const { host, err } = await headless(['--peer-rts', 'ignore'])
    expect(host.flowControl).toBe(false)
    expect(err).toContain('no flow control')
  })

  it('still refuses --serial-flow headless, where there is no host port', async () => {
    await expect(runCommand(['--headless', '--serial-flow', 'none'])).rejects.toThrow(/--serial-flow/)
  })
})
