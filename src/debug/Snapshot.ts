import { StateError } from '../core/DeviceState'
import type { DeviceState } from '../core/DeviceState'
import type { Machine, SlotName } from '../core/Machine'
import { crc32 } from './Checksums'

export { StateError }

/**
 * Whole-machine save and restore.
 *
 * The point, stated plainly: today every test run pays the BIOS countdown and
 * the KC Monitor's cold start — and the LCD's power-on ritual, which is four
 * software delays of ~41 ms each and costs around 1.8 M cycles before the
 * splash clears. With snapshots an agent boots once, saves at the monitor, and
 * restores per test case. It also gives a person a reproducible bug report:
 * here is the machine one instruction before it breaks.
 *
 * A snapshot is plain JSON so it travels over the debug protocol unchanged and a
 * person can read one in an editor. The size, for the standard slot layout at
 * the monitor, is around 50 KB — RAM in full, and almost nothing else, because
 * the KIM's cards hold registers rather than images.
 */

/**
 * Bumped whenever a stored field changes meaning.
 *
 * Loading is an exact-match check, never a best effort: a snapshot from another
 * version restores *most* of a machine, and a machine assembled from most of a
 * snapshot fails in ways nobody can reason about. Refusing costs a re-record.
 */
export const SNAPSHOT_VERSION = 1

/** Identifies the file, so a wrong path fails as "not a snapshot", not as JSON. */
export const SNAPSHOT_FORMAT = '6502-kim-snapshot'

/** ROM enough to tell one apart, without carrying 32 KB of it. */
export interface ROMIdentity {
  length: number
  /** CRC-32, lower case hex. Not a security claim — just an identity. */
  crc32: string
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT
  version: number
  /** Informational: when the snapshot was taken, in host wall-clock time. */
  createdAt: string

  /** PHI2 in Hz, so a 2 MHz machine does not restore as a 1 MHz one. */
  frequency: number

  /**
   * The machine's cycle counter when the snapshot was taken. Informational.
   *
   * Not restored. `Machine.cycles` is a monotonic measure of elapsed emulated
   * time that cycle budgets, `wait.for {cycles}` and the step limits are all
   * expressed against; rewinding it would make every one of them report
   * negative progress across a restore. Nothing the machine emulates reads it —
   * the cards keep their own accumulators, and those *are* restored — so
   * determinism does not depend on it.
   */
  cycles: number

  /**
   * The BIOS the snapshot was taken against, by identity rather than by content.
   *
   * A snapshot is worthless without the matching BIOS — the PC in it may point
   * into that ROM — but the ROM is 32 KB that the host always loads at startup
   * anyway, so storing a checksum and refusing a mismatch is both smaller and
   * more useful than storing a copy that could disagree with the machine.
   */
  rom: ROMIdentity

  /**
   * The Keypad Card's ROM, the same way, and for a sharper reason.
   *
   * This is where 6502-EMULATOR stores the cartridge image in full, because a
   * cartridge can be swapped on a running machine and the host has no way to
   * find those bytes again. Nothing here can be swapped mid-run: the card is
   * soldered in, and the only way to change its ROM is Settings → FILES, which
   * is loading a build rather than inserting media. So identity is enough — and
   * it is the check that matters most on this machine, because the KC Monitor is
   * developed in the sibling repository and the failure this catches is
   * restoring yesterday's session onto today's firmware.
   */
  cardROM: ROMIdentity

  cpu: DeviceState
  ram: DeviceState

  /**
   * The Keypad Card's PIA, and with it the keypad and the LCD.
   *
   * One field rather than three: both peripherals are wired to the PIA's ports
   * and it serializes them inside its own state, which is the honest encoding of
   * a card where the 65C21 is the only thing on the bus. It is out here beside
   * `cpu` and `ram` rather than in `slots` because the card is not in a slot.
   */
  pia: DeviceState

  /** The eight slot cards in address order, io1 first. */
  slots: DeviceState[]
}

const SLOT_NAMES: SlotName[] = ['io1', 'io2', 'io3', 'io4', 'io5', 'io6', 'io7', 'io8']

const romIdentity = (rom: { data: number[] }): ROMIdentity => ({
  length: rom.data.length,
  crc32: crc32(Uint8Array.from(rom.data)).toString(16).padStart(8, '0')
})

/**
 * Capture the machine as it stands.
 *
 * Safe to call at any point, including mid-instruction: the CPU's working
 * registers and every card's cycle accumulator are part of what is stored, so a
 * snapshot taken between two ticks resumes as the same instruction rather than
 * re-decoding from a PC that has already moved.
 */
export function captureSnapshot(machine: Machine): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    frequency: machine.frequency,
    cycles: machine.cycles,
    rom: romIdentity(machine.rom),
    cardROM: romIdentity(machine.cardROM),
    cpu: machine.cpu.serialize(),
    ram: machine.ram.serialize(),
    pia: machine.pia.serialize(),
    slots: machine.slots().map((card) => card.serialize())
  }
}

export interface RestoreOptions {
  /**
   * Apply the snapshot even though a ROM is not the one in the machine.
   *
   * Occasionally right — patching a BIOS, or replaying a saved session against a
   * rebuilt KC Monitor to see what the change did, are both real things to want
   * — and wrong by default, because the far more common cause of a mismatch is
   * restoring against the wrong build entirely, which produces a machine that
   * crashes somewhere unrelated.
   */
  force?: boolean
}

/** A ROM that did not match, reported when `force` let the restore through. */
export interface ROMMismatch {
  expected: ROMIdentity
  actual: ROMIdentity
}

export interface RestoreResult {
  /** Set when the BIOS did not match and `force` allowed it through anyway. */
  romMismatch?: ROMMismatch
  /** The same, for the Keypad Card's ROM. */
  cardROMMismatch?: ROMMismatch
}

/**
 * Apply a snapshot to a machine.
 *
 * Validates before it writes anything it can — format, version, slot layout and
 * both ROM identities — because a restore that fails halfway leaves a machine
 * that is part one program and part another. The per-card checks cannot all be
 * hoisted (a card only knows its own fields), so a card that throws does abandon
 * the restore mid-way; the caller's recourse is to reset, which is why
 * `state.load` says so in its error rather than pretending the machine is still
 * usable.
 */
export function restoreSnapshot(
  machine: Machine,
  snapshot: unknown,
  options: RestoreOptions = {}
): RestoreResult {
  const state = validate(snapshot)
  const result: RestoreResult = {}

  const checkROM = (
    label: string,
    expected: ROMIdentity,
    rom: { data: number[] }
  ): ROMMismatch | undefined => {
    const actual = romIdentity(rom)
    if (expected.crc32 === actual.crc32 && expected.length === actual.length) return undefined
    if (!options.force) {
      throw new StateError(
        `snapshot: taken against a different ${label} (${expected.crc32}, ` +
          `${expected.length} bytes; this machine has ${actual.crc32}, ${actual.length}) — ` +
          'load the matching image, or pass force to restore anyway'
      )
    }
    return { expected, actual }
  }

  const romMismatch = checkROM('BIOS ROM', state.rom, machine.rom)
  if (romMismatch) result.romMismatch = romMismatch

  const cardMismatch = checkROM('Keypad Card ROM', state.cardROM, machine.cardROM)
  if (cardMismatch) result.cardROMMismatch = cardMismatch

  // Slot kinds first: every card's own deserialize checks its own kind, but
  // finding out at slot 7 means slots 1-6 have already been overwritten.
  const cards = machine.slots()
  state.slots.forEach((slotState, index) => {
    const card = cards[index]!
    if (slotState.kind !== card.kind) {
      throw new StateError(
        `snapshot: ${SLOT_NAMES[index]} holds a ${card.kind} card, ` +
          `the snapshot has ${String(slotState.kind)} — the snapshot was taken from a ` +
          'machine with a different slot configuration'
      )
    }
  })

  machine.frequency = state.frequency

  machine.cpu.deserialize(state.cpu)
  machine.ram.deserialize(state.ram)
  machine.pia.deserialize(state.pia)
  state.slots.forEach((slotState, index) => cards[index]!.deserialize(slotState))

  return result
}

/** Check the envelope, and narrow `unknown` to something with named fields. */
function validate(snapshot: unknown): Snapshot {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new StateError('snapshot: expected an object')
  }

  const candidate = snapshot as Record<string, unknown>

  if (candidate.format !== SNAPSHOT_FORMAT) {
    throw new StateError(
      `snapshot: not a 6502-KIM snapshot (format is ${JSON.stringify(candidate.format)})`
    )
  }
  if (candidate.version !== SNAPSHOT_VERSION) {
    throw new StateError(
      `snapshot: version ${String(candidate.version)}, this build reads version ${SNAPSHOT_VERSION}`
    )
  }
  if (typeof candidate.frequency !== 'number' || !Number.isFinite(candidate.frequency)) {
    throw new StateError('snapshot.frequency: expected a number')
  }

  for (const field of ['rom', 'cardROM'] as const) {
    const rom = candidate[field]
    if (
      typeof rom !== 'object' ||
      rom === null ||
      typeof (rom as ROMIdentity).crc32 !== 'string' ||
      typeof (rom as ROMIdentity).length !== 'number'
    ) {
      throw new StateError(`snapshot.${field}: expected { length, crc32 }`)
    }
  }

  const slots = candidate.slots
  if (!Array.isArray(slots) || slots.length !== SLOT_NAMES.length) {
    throw new StateError(`snapshot.slots: expected ${SLOT_NAMES.length} entries`)
  }
  slots.forEach((slot, index) => {
    if (typeof slot !== 'object' || slot === null || typeof (slot as DeviceState).kind !== 'string') {
      throw new StateError(`snapshot.slots[${index}]: expected a state object with a "kind"`)
    }
  })

  for (const field of ['cpu', 'ram', 'pia'] as const) {
    const value = candidate[field]
    if (typeof value !== 'object' || value === null || typeof (value as DeviceState).kind !== 'string') {
      throw new StateError(`snapshot.${field}: expected a state object with a "kind"`)
    }
  }

  return candidate as unknown as Snapshot
}
