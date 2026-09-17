import { join } from 'path'

/**
 * The folder settings live in, pinned rather than derived.
 *
 * Electron names `userData` after the app: `productName` in the packaged
 * `package.json` if there is one, else `name`. Up to 1.0.10 that was
 * `6502-kimulator`, so every installed copy keeps its `settings.json` (and
 * Chromium's own storage) in `<appData>/6502-kimulator`. 1.0.11 renamed the
 * product to "AC6502 KIMulator" and the package to `ac6502-kimulator`, which
 * would silently move `userData` to a new, empty folder and lose every saved
 * setting. Pinning it here keeps the old folder, whatever the app is called.
 *
 * Never change this string: it is where people's saved data already is.
 */
export const USER_DATA_FOLDER = '6502-kimulator'

/** `userData` for a given `appData` (`app.getPath('appData')`). */
export function userDataPath(appData: string): string {
  return join(appData, USER_DATA_FOLDER)
}
