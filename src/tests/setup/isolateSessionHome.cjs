/**
 * Give every test file its own `~/.6502-kim`.
 *
 * The debug server records the live session in a single lock file —
 * `LockFile.ts` puts it at `$SIXTY5O2_KIM_HOME/session.json`, defaulting to
 * `~/.6502-kim`. That is right for the product: there is one machine, so there is
 * one session, and `6502-kim dbg` finds it without being told where to look.
 *
 * It is wrong for a test run. Jest gives each test file its own worker and runs
 * several at once, so the files that start a real server —
 * `debug/server/DebugServer` and `cli/dbg/Commands` — were writing and clearing
 * the same path at the same time, and could take each other's lock out from
 * under them. It also meant a test run trod on a real session the developer had
 * open, and that a real session could fail the suite.
 *
 * `cli/dbg/Connection` already worked around it by pointing the variable at a
 * temp directory itself. This does it once, for all of them, before any module
 * is loaded — so a test added later inherits the isolation instead of having to
 * know about it. 6502-EMULATOR carries the same file for the same reason.
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

process.env.SIXTY5O2_KIM_HOME = mkdtempSync(join(tmpdir(), '6502-test-'))
