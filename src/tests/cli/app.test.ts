import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { UsageError } from '../../cli/args'
import { buildBootConfig, resolveApp } from '../../cli/app'
import { ROM } from '../../core/ROM'
import { CardROM } from '../../core/CardROM'
import { DEFAULT_SERIAL_CONFIG } from '../../shared/types'

/**
 * `6502-kim run` without `--headless` launches the desktop app, which means the
 * flags are checked here, in the terminal, rather than in a window that opens
 * missing half of what was asked for. That is what these cover: what the app is
 * told to boot with, and what it is told is a mistake.
 */

let dir: string
let binary: string
let bios: string
let cardROM: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '6502-kim-app-test-'))
  binary = join(dir, 'counter.bin')
  writeFileSync(binary, Uint8Array.from([0xa9, 0x41]))
  bios = join(dir, 'BIOS.bin')
  writeFileSync(bios, new Uint8Array(ROM.SIZE))
  cardROM = join(dir, 'KCMonitor.bin')
  writeFileSync(cardROM, new Uint8Array(CardROM.SIZE))
})

describe('buildBootConfig', () => {
  it('carries both ROMs, resolved against the shell rather than the app', () => {
    // The app is launched from somewhere else entirely, so a relative path is
    // meaningless by the time it arrives.
    const config = buildBootConfig({ rom: bios, 'card-rom': cardROM }, [])
    expect(config).toEqual({ rom: resolve(bios), cardROM: resolve(cardROM) })
  })

  it('refuses a file it cannot read, naming the flag', () => {
    expect(() => buildBootConfig({ rom: join(dir, 'nope.bin') }, [])).toThrow(/--rom: cannot read/)
    expect(() => buildBootConfig({ bin: [`0x0800=${join(dir, 'nope.bin')}`] }, [])).toThrow(
      /--bin: cannot read/
    )
  })

  /**
   * The renderer's ROM slots ignore a wrong-size image rather than throwing, so
   * left to the app this is a window that boots to nothing with no explanation.
   * The card ROM matters more than the BIOS: it carries the reset vectors.
   */
  it('refuses either ROM at the wrong size, and says which size it wanted', () => {
    expect(() => buildBootConfig({ rom: cardROM }, [])).toThrow(/--rom: must be exactly 32768/)
    expect(() => buildBootConfig({ 'card-rom': bios }, [])).toThrow(
      /--card-rom: must be exactly 8192/
    )
  })

  /**
   * There is no program argument on this machine — no BASIC to load a `.prg`
   * into — so a path where 6502-EMULATOR would take one is a mistake worth
   * pointing at the flag that replaces it.
   */
  it('refuses a positional program and points at --bin', () => {
    expect(() => buildBootConfig({}, [binary])).toThrow(/--bin <addr>=<file>/)
  })

  it('refuses flags that only mean something without a window, and says why', () => {
    expect(() => buildBootConfig({ timeout: '5s' }, [])).toThrow(UsageError)
    expect(() => buildBootConfig({ 'exit-on': 'KIM' }, [])).toThrow(/--exit-on/)
    // All of them at once: someone adapting a headless command line should see
    // the whole list rather than fixing one flag per attempt.
    expect(() => buildBootConfig({ lcd: true, json: true }, [])).toThrow(/--lcd[\s\S]*--json/)
  })

  it('carries the machine settings across', () => {
    expect(buildBootConfig({ pause: true, fullscreen: true }, [])).toMatchObject({
      pause: true,
      fullscreen: true
    })
  })

  it('puts what the Settings panel owns under settings, for the launch only', () => {
    const config = buildBootConfig({ 'no-serial-card': true, accessory: 'led-latch' }, [])
    expect(config.settings).toEqual({ serialCardFitted: false, accessory: 'led-latch' })
  })

  it('refuses an accessory this build does not have', () => {
    expect(() => buildBootConfig({ accessory: 'leds' }, [])).toThrow(/no accessory "leds"/)
  })

  it('carries --flow-control and --no-flow-control into the settings for this launch, and only when given', () => {
    expect(buildBootConfig({ 'flow-control': true }, []).settings).toEqual({ flowControl: true })
    expect(buildBootConfig({ 'no-flow-control': true }, []).settings).toEqual({ flowControl: false })
    expect(buildBootConfig({}, []).settings).toBeUndefined()
    expect(() => buildBootConfig({ 'flow-control': true, 'no-flow-control': true }, [])).toThrow(
      '--flow-control and --no-flow-control cannot both be given'
    )
  })

  it('builds a whole serial config, never half of one', () => {
    // Merging framing into whatever was saved would produce a line nobody
    // asked for, so a flag that touches the port starts from the default.
    expect(buildBootConfig({ baud: '9600' }, []).settings?.serialConfig).toEqual({
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    expect(buildBootConfig({ 'serial-config': '7e2' }, []).settings?.serialConfig).toEqual({
      baudRate: 19200,
      dataBits: 7,
      parity: 'even',
      stopBits: 2
    })
    expect(() => buildBootConfig({ 'serial-config': '9Z3' }, [])).toThrow(/like 8N1/)
  })

  it('sets the serial card and its jumper for the launch, and the console\'s RTS', () => {
    expect(buildBootConfig({ 'serial-card': 'standard', cts: 'cable' }, []).settings).toEqual({
      serialCardConfig: { card: 'standard', jumpers: { cts: 'cable' } }
    })
    expect(buildBootConfig({ 'serial-card': 'pro' }, []).settings).toEqual({
      serialCardConfig: { card: 'pro', jumpers: { dcd: 'ground' } }
    })
    expect(buildBootConfig({ 'peer-rts': 'ignore' }, []).settings).toEqual({ flowControl: false })
    expect(() => buildBootConfig({ 'serial-card': 'pro', cts: 'ground' }, [])).toThrow(
      /the Serial Card Pro has no CTS jumper/
    )
  })

  /**
   * The ACE's R6551 is on the ACE board. 6502-EMULATOR offers it, and the
   * obvious way to port that option parser is to copy all three cards, so the
   * refusal is pinned here: a usage error that says why, never a quiet
   * fallback to the Serial Card.
   */
  it('refuses the ACE, which cannot be fitted to a KIM', () => {
    expect(() => buildBootConfig({ 'serial-card': 'ace' }, [])).toThrow(
      '--serial-card ace: the ACE\'s serial is on the ACE board, and cannot be fitted to a KIM'
    )
    expect(() => buildBootConfig({ 'serial-card': 'ACE', dcd: 'cable' }, [])).toThrow(/cannot be fitted to a KIM/)
  })

  it('refuses a card or jumper for an io5 that --no-serial-card leaves vacant', () => {
    expect(() => buildBootConfig({ 'no-serial-card': true, cts: 'cable' }, [])).toThrow(
      '--cts: describes the card in io5, and --no-serial-card leaves io5 vacant'
    )
  })

  /**
   * The host port's own RTS/CTS, deprecated in 1.2: the machine drives the
   * port's RTS itself now. Still parsed, so a typo is still an error, and a
   * script that passes it keeps running — but it sets nothing at all.
   */
  it('parses --serial-flow and ignores it', () => {
    expect(buildBootConfig({ 'serial-flow': 'none' }, []).settings).toBeUndefined()
    expect(buildBootConfig({ 'serial-flow': 'rtscts' }, []).settings).toBeUndefined()
    expect(buildBootConfig({ 'serial-flow': 'none', baud: '9600' }, []).settings?.serialConfig).toEqual({
      ...DEFAULT_SERIAL_CONFIG,
      baudRate: 9600
    })
    expect(buildBootConfig({ 'no-flow-control': true }, []).settings?.serialConfig).toBeUndefined()
    expect(() => buildBootConfig({ 'serial-flow': 'hardware' }, [])).toThrow(
      /expected rtscts or none/
    )
  })

  it('treats a serial port as an action, not a setting', () => {
    // The app does not remember a port between runs, so this is something to
    // do at launch rather than something to put in the panel.
    const config = buildBootConfig({ serial: '/dev/tty.usbserial-1420' }, [])
    expect(config.serialPort).toBe('/dev/tty.usbserial-1420')
    expect(config.settings).toBeUndefined()
  })

  it('parses --bin the same way the headless path does', () => {
    const config = buildBootConfig({ bin: [`0x0800=${binary}`] }, [])
    expect(config.binaries).toEqual([{ address: 0x0800, path: resolve(binary) }])
  })

  it('only asks for a debug server when --debug says so', () => {
    expect(buildBootConfig({ 'debug-port': '9000' }, []).debug).toBeUndefined()
    expect(buildBootConfig({ debug: true }, []).debug).toEqual({})
    expect(
      buildBootConfig({ debug: true, 'debug-port': '9000', 'debug-token': 'abc' }, []).debug
    ).toEqual({ port: 9000, token: 'abc' })
  })

  it('leaves out what was not asked for', () => {
    // Absent is absent: main reads only the keys that are present, so an
    // explicit undefined would be indistinguishable from a file named "".
    expect(Object.keys(buildBootConfig({}, []))).toEqual([])
  })
})

describe('resolveApp', () => {
  it('takes an explicit path, and reports one that is not there', () => {
    expect(resolveApp(binary)).toEqual({ command: binary, args: [] })
    expect(() => resolveApp(join(dir, 'missing'))).toThrow(/--app: nothing to run/)
  })

  it('looks inside a macOS bundle for the executable', () => {
    // `--app "/Applications/AC6502 KIMulator.app"` is what a person would type;
    // the thing to spawn is the binary buried in it.
    expect(() => resolveApp('/nowhere/AC6502 KIMulator.app')).toThrow(
      /Contents\/MacOS\/AC6502 KIMulator/
    )
  })
})
