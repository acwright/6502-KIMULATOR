import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where a running emulator publishes how to reach it.
 *
 * The whole point is that `6502-kim dbg regs` takes no arguments. An agent
 * calling the CLI from a shell has nowhere to keep a port number between
 * invocations — every call is a fresh process — so the running emulator has to
 * leave it somewhere well-known.
 */
export interface SessionLock {
  pid: number
  host: string
  port: number
  token: string
  /** ISO timestamp, so a human reading the file can tell how old it is. */
  started: string
  version: string
  host_kind: 'headless' | 'electron'
  /** Where the emulator was launched from, to tell instances apart. */
  cwd?: string
}

/**
 * `~/.6502-kim/session.json`, not `~/.6502/session.json`.
 *
 * The one place the lock file has to diverge from 6502-EMULATOR's. The two
 * emulators are separate applications a person can perfectly well run at the
 * same time, and sharing a path would mean the second to start finds the lock
 * held and refuses — or, worse, that `6502-kim dbg` attaches to an ACE and
 * reports its registers without either side noticing. Same reasoning as the CLI
 * being named `6502-kim` rather than `6502`.
 */
export function defaultLockPath(): string {
  return join(process.env.SIXTY5O2_KIM_HOME ?? join(homedir(), '.6502-kim'), 'session.json')
}

export function writeLock(path: string, lock: SessionLock): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // 0600: the file holds the token that authorises driving the machine and
  // rewriting its memory. Other users on the box have no business with it.
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read the lock, or report why it is unusable.
 *
 * A lock left behind by a crashed process is the common case, not an edge one —
 * a Ctrl-C during a `finally` that never ran, an OOM kill. Checking the pid is
 * what stops the next `6502-kim dbg` from timing out against a dead port.
 */
export function readLock(path: string): SessionLock | undefined {
  if (!existsSync(path)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined
  const lock = parsed as Partial<SessionLock>
  if (typeof lock.port !== 'number' || typeof lock.token !== 'string') return undefined
  if (typeof lock.pid !== 'number' || !isAlive(lock.pid)) return undefined

  return lock as SessionLock
}

/** Remove a lock, tolerating one that has already gone. */
export function clearLock(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A lock we cannot remove is not worth failing a shutdown over.
  }
}

/**
 * Is this process still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means it exists but belongs to someone else — still alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
