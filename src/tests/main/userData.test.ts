import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_NAME, USER_DATA_FOLDER, userDataPath } from '../../main/userData'

const root = join(__dirname, '..', '..', '..')

describe('userData stays where 1.0.10 left it', () => {
  let appData: string

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'kim-appdata-'))
  })

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true })
  })

  it('is the folder 1.0.10 and earlier wrote to', () => {
    expect(USER_DATA_FOLDER).toBe('6502-kimulator')
  })

  it('finds an existing settings.json from before the rename', () => {
    // What an installed 1.0.10 leaves behind.
    const old = join(appData, '6502-kimulator')
    mkdirSync(old)
    writeFileSync(join(old, 'settings.json'), JSON.stringify({ flowControl: true }))

    const dir = userDataPath(appData)
    expect(dir).toBe(old)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ flowControl: true })
  })

  it('is not derived from the product or package name', () => {
    // Either of these is what Electron would pick on its own, and both changed.
    const productName = /^productName:\s*(.+)$/m.exec(readFileSync(join(root, 'electron-builder.yml'), 'utf8'))![1].trim()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; productName?: string }

    expect(productName).toBe('AC6502 KIMulator')
    expect(pkg.name).toBe('ac6502-kimulator')
    for (const derived of [productName, pkg.name, pkg.productName].filter(Boolean)) {
      expect(userDataPath(appData)).not.toBe(join(appData, derived!))
    }
    expect(existsSync(userDataPath(appData))).toBe(false) // nothing is created by asking
  })

  it('is pinned in the main process before anything reads it', () => {
    const main = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    const pin = main.indexOf("app.setPath('userData', userDataPath(app.getPath('appData')))")
    expect(pin).toBeGreaterThan(-1)
    // Before the services that read it are constructed, and before `ready`.
    expect(pin).toBeLessThan(main.indexOf('app.whenReady()'))
  })
})

/**
 * `app.name` is what the macOS application menu's About, Hide and Quit items
 * are built from, and the bundle is named by `productName`. They are two
 * strings in two files, and until 1.2.1 they disagreed: the menu read
 * "About ac6502-kimulator", the npm package's name, because nothing ever
 * called `app.setName`.
 */
describe('APP_NAME', () => {
  it('is what the bundle is called', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const productName = /^productName:\s*(.+?)\s*$/m.exec(yml)?.[1]
    expect(productName).toBe('AC6502 KIMulator')
    expect(APP_NAME).toBe(productName)
  })

  it('is not what the settings folder is called', () => {
    expect(USER_DATA_FOLDER).not.toBe(APP_NAME)
  })

  /**
   * Order matters. `userData` is pinned to an absolute path first, so renaming
   * the app cannot move it; the other order would leave a window in which
   * Electron's name-derived default is the live one.
   */
  it('is set after the folder is pinned, and before ready', () => {
    const main = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')
    const pin = main.indexOf("app.setPath('userData'")
    const name = main.indexOf('app.setName(APP_NAME)')
    expect(name).toBeGreaterThan(pin)
    expect(name).toBeLessThan(main.indexOf('app.whenReady()'))
  })
})
