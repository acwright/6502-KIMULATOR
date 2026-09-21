import { join } from 'path'

/**
 * What the app calls itself: the window, the About panel, and the macOS
 * application menu's *About*, *Hide* and *Quit* items, which Electron builds
 * from `app.name`.
 *
 * It must equal `productName` in `electron-builder.yml`, which is what the
 * bundle is named — the menu saying one thing and the Dock another is exactly
 * the bug this fixes. Without `app.setName`, `app.name` falls back to `name`
 * in `package.json`, which is the npm package identifier: up to 1.2.0 the menu
 * read *About ac6502-kimulator*.
 *
 * It is a separate string from `USER_DATA_FOLDER` below on purpose, and the
 * two must never be spelled from each other. That is the whole point of
 * pinning the folder: the display name has changed once and may change again,
 * and people's settings must not follow it.
 */
export const APP_NAME = 'AC6502 KIMulator'

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
