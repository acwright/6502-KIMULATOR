/**
 * PHI2, the CPU clock: 1 MHz, the AC6502's standard, or 2 MHz.
 *
 * The KIM is drawn, built and tested at 1 MHz, and the KIM Board is not cleared
 * for 2 MHz: it has never run at it, and the bench KIM it replaces misread its
 * RAM at 2 MHz (6502-WORKING P11, 2026-11-11). 2 MHz is the builder's risk. So
 * this emulator offers it as a Setting with that said beside it, and on the
 * command line, but never on the control bar, as 6502-EMULATOR does
 * (`src/shared/clock.ts` there).
 *
 * The note names the machine, the KIM, and nothing below it: no board, PCB,
 * revision or part. This emulator represents the KIM, not a particular build of
 * it, and build notes belong in each board's own documentation (owner,
 * 2026-11-21).
 */
export const CLOCK_1MHZ = 1_000_000
export const CLOCK_2MHZ = 2_000_000

/** The clocks a machine can run at, in Hz. */
export const CLOCK_FREQUENCIES: readonly number[] = [CLOCK_1MHZ, CLOCK_2MHZ]

export const DEFAULT_FREQUENCY = CLOCK_1MHZ

/** What the Settings panel, `--help` and the docs say beside the choice. */
export const CLOCK_NOTE =
  '1 MHz is the AC6502 standard, and the KIM is tested at it. 2 MHz is untested on the KIM.'

/** True for a clock this emulator runs at. */
export function isClockFrequency(value: unknown): value is number {
  return typeof value === 'number' && CLOCK_FREQUENCIES.includes(value)
}

/**
 * `1`, `2`, `1MHz`, `2 MHz`, `1000000` or `2_000_000` as Hz, or null for
 * anything else. The command line, `dbg config` and an embed's `freq=` all read
 * it this way.
 */
export function readClockText(text: string): number | null {
  const normalised = text.trim().toLowerCase().replace(/[\s_]/g, '')
  if (normalised === '1' || normalised === '1mhz') return CLOCK_1MHZ
  if (normalised === '2' || normalised === '2mhz') return CLOCK_2MHZ
  const value = Number(normalised)
  return isClockFrequency(value) ? value : null
}

/** `1 MHz` or `2 MHz`. */
export function describeClock(frequency: number): string {
  return `${frequency / 1e6} MHz`
}
