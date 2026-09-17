import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { USER_DATA_FOLDER, userDataPath } from '../../main/userData'

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
