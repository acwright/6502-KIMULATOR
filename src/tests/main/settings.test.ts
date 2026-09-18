import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS, SETTINGS_VERSION } from '../../shared/types'
import { SettingsService } from '../../main/settings'
import { Machine } from '../../core/Machine'
import { ACIA } from '../../core/IO/ACIA'

/**
 * Flow control became on by default in 1.1. 1.0.10 and 1.0.11 wrote the whole
 * settings object on every change, so their files hold `flowControl: false`
 * whether or not anyone chose it; a file without a version is migrated once.
 */

const dir = mkdtempSync(join(tmpdir(), '6502-kim-settings-test-'))
const settingsFile = join(dir, 'settings.json')

jest.mock('electron', () => ({ app: { getPath: () => (global as { __settingsDir?: string }).__settingsDir } }))

beforeAll(() => {
  ;(global as { __settingsDir?: string }).__settingsDir = dir
})

afterEach(() => rmSync(settingsFile, { force: true }))

const onDisk = (): unknown =>
  existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : undefined

describe('SettingsService', () => {
  const legacy = { ...DEFAULT_APP_SETTINGS, accessory: 'leds', flowControl: false }
  delete (legacy as { settingsVersion?: number }).settingsVersion

  it('has flow control on, and the current version, with no file', () => {
    expect(new SettingsService().get()).toMatchObject({ flowControl: true, settingsVersion: SETTINGS_VERSION })
    expect(onDisk()).toBeUndefined()
  })

  it('turns flow control on once in a file without a version, keeps everything else, and writes the version back', () => {
    writeFileSync(settingsFile, JSON.stringify(legacy))
    const settings = new SettingsService()
    expect(settings.get()).toMatchObject({ flowControl: true, accessory: 'leds', settingsVersion: SETTINGS_VERSION })
    expect(onDisk()).toMatchObject({ flowControl: true, accessory: 'leds', settingsVersion: SETTINGS_VERSION })
  })

  it('keeps flow control off when it is turned off after the migration', () => {
    writeFileSync(settingsFile, JSON.stringify(legacy))
    new SettingsService().set({ flowControl: false })

    expect(new SettingsService().get().flowControl).toBe(false)
    expect(onDisk()).toMatchObject({ flowControl: false, settingsVersion: SETTINGS_VERSION })
  })

  it('leaves a current file alone', () => {
    writeFileSync(settingsFile, JSON.stringify({ ...DEFAULT_APP_SETTINGS, flowControl: false }))
    const before = readFileSync(settingsFile, 'utf8')
    expect(new SettingsService().get().flowControl).toBe(false)
    expect(readFileSync(settingsFile, 'utf8')).toBe(before)
  })

  /**
   * A saved `serialConfig` missing a field added since takes the default for
   * it, rather than arriving undefined. A current file with the port's
   * `rtscts` in it still loads: the field is deprecated and ignored (the
   * machine drives the port's RTS), not an error.
   */
  it('merges a saved serial config over the defaults, and still loads one with rtscts', () => {
    writeFileSync(settingsFile, JSON.stringify({ serialConfig: { baudRate: 4800 } }))
    expect(new SettingsService().get().serialConfig).toEqual({
      ...DEFAULT_APP_SETTINGS.serialConfig,
      baudRate: 4800
    })

    writeFileSync(
      settingsFile,
      JSON.stringify({
        ...DEFAULT_APP_SETTINGS,
        serialConfig: { ...DEFAULT_APP_SETTINGS.serialConfig, baudRate: 9600, rtscts: false }
      })
    )
    expect(new SettingsService().get().serialConfig.baudRate).toBe(9600)
    rmSync(settingsFile)
  })

  /**
   * The serial card's model and jumper, added in 1.2. A file that predates it
   * gets the Serial Card with `CTS EN` at ground, which is the machine it
   * always ran; one naming a card this app does not offer — the ACE, which
   * cannot be fitted to a KIM — or a jumper the card lacks, is not something
   * to build a machine from.
   */
  it('reads the serial card, and falls back to the Serial Card at ground for anything else', () => {
    writeFileSync(settingsFile, JSON.stringify({ accessory: 'leds' }))
    expect(new SettingsService().get().serialCardConfig).toEqual({
      card: 'standard',
      jumpers: { cts: 'ground' }
    })

    writeFileSync(
      settingsFile,
      JSON.stringify({ serialCardConfig: { card: 'pro', jumpers: { cts: 'cable', dcd: 'cable' } } })
    )
    expect(new SettingsService().get().serialCardConfig).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })

    writeFileSync(settingsFile, JSON.stringify({ serialCardConfig: { card: 'ace', jumpers: { cts: 'cable' } } }))
    expect(new SettingsService().get().serialCardConfig).toEqual({ card: 'standard', jumpers: { cts: 'ground' } })
    rmSync(settingsFile)
  })

  describe('migrating a file written by 1.1.2 (version 2)', () => {
    /**
     * What 1.1.2 wrote, spelled out rather than built from today's defaults,
     * which is what it is being migrated to. `rtscts` was the port's own flow
     * control; `flowControl` the far end of the emulated machine's cable.
     */
    function written112(flowControl: boolean, rtscts: boolean): Record<string, unknown> {
      return {
        serialConfig: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, rtscts },
        serialCardFitted: true,
        accessory: 'led-latch',
        flowControl,
        settingsVersion: 2
      }
    }

    /** Fit a machine from settings the way useMachine and the store do. */
    function machineFrom(settings: { flowControl: boolean; serialCardConfig: Machine['serialCard'] }): Machine {
      const machine = new Machine()
      machine.flowControl = settings.flowControl
      machine.serialCard = settings.serialCardConfig
      return machine
    }

    it.each([
      [true, true],
      [false, true],
      [true, false],
      [false, false]
    ])('keeps flowControl %s, drops rtscts %s, and fits the Serial Card at ground', (flowControl, rtscts) => {
      writeFileSync(settingsFile, JSON.stringify(written112(flowControl, rtscts)))
      const loaded = new SettingsService().get()

      expect(loaded).toEqual({
        serialConfig: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 },
        serialCardFitted: true,
        serialCardConfig: { card: 'standard', jumpers: { cts: 'ground' } },
        accessory: 'led-latch',
        flowControl,
        settingsVersion: 3
      })
      // Once, and written back.
      expect(onDisk()).toEqual(loaded)
    })

    /**
     * The behaviour, not just the fields. 1.1.2's machine had CTS, DCD and DSR
     * hardwired asserted: nothing the far end did could reach them. The
     * migrated machine is the Serial Card with `CTS EN` at ground and DCD and
     * DSR tied off, so a far end dropping every line it has changes nothing at
     * all — and the far end honours RTS exactly as the file said.
     */
    it('builds a machine that behaves as 1.1.2\'s did, whatever the far end does', () => {
      for (const flowControl of [true, false]) {
        writeFileSync(settingsFile, JSON.stringify(written112(flowControl, true)))
        const machine = machineFrom(new SettingsService().get())
        const acia = machine.io5 as ACIA

        machine.write(0x9002, 0x09) // DTR on, TIC 10: receiver and transmitter on
        machine.setSerialLines({ cts: false, dcd: false, dsr: false })

        expect(acia.transmitterEnabled).toBe(true)
        expect(acia.receiverEnabled).toBe(true)
        expect(machine.read(0x9001) & 0x60).toBe(0) // DCD and DSR read low, as they always did
        expect(machine.flowControl).toBe(flowControl)

        // RTS raised: the far end holds its bytes exactly when it honours RTS.
        machine.write(0x9002, 0x01)
        expect(machine.serialReady).toBe(!flowControl)
        rmSync(settingsFile)
      }
    })

    it('keeps a keypad-only machine keypad-only', () => {
      writeFileSync(settingsFile, JSON.stringify({ ...written112(true, true), serialCardFitted: false }))
      expect(new SettingsService().get()).toMatchObject({ serialCardFitted: false, settingsVersion: 3 })
    })

    it('leaves a version 3 file alone', () => {
      writeFileSync(
        settingsFile,
        JSON.stringify({ ...DEFAULT_APP_SETTINGS, serialCardConfig: { card: 'pro', jumpers: { dcd: 'cable' } } })
      )
      const before = readFileSync(settingsFile, 'utf8')
      expect(new SettingsService().get().serialCardConfig).toEqual({ card: 'pro', jumpers: { dcd: 'cable' } })
      expect(readFileSync(settingsFile, 'utf8')).toBe(before)
    })
  })

  it('keeps a --no-flow-control launch out of the file', () => {
    const settings = new SettingsService()
    settings.override({ flowControl: false })
    settings.set({ accessory: null })
    expect(settings.get().flowControl).toBe(false)
    expect(onDisk()).toMatchObject({ flowControl: true })
  })
})
