import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS, SETTINGS_VERSION } from '../../shared/types'
import { SettingsService } from '../../main/settings'

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

  it('keeps a --no-flow-control launch out of the file', () => {
    const settings = new SettingsService()
    settings.override({ flowControl: false })
    settings.set({ accessory: null })
    expect(settings.get().flowControl).toBe(false)
    expect(onDisk()).toMatchObject({ flowControl: true })
  })
})
