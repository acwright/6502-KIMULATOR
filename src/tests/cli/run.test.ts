import { runCommand } from '../../cli/run'
import { HeadlessHost } from '../../host/headless/HeadlessHost'

jest.setTimeout(60_000)

describe('run --flow-control / --no-flow-control', () => {
  it('is in the help, and says it is on by default', async () => {
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
    expect(chunks.join('')).toMatch(/--flow-control +Hold serial input while the machine raises RTS \(default: on\)/)
    expect(chunks.join('')).toMatch(/--no-flow-control +Send serial input whatever RTS says/)
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
