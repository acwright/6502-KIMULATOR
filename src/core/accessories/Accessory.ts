import type { IO } from '../IO'

/**
 * The accessory bus, and how a circuit describes itself to it.
 *
 * `io6` (`$9400–$97FF`) is where a breadboard gets wired on a real KIM. Both of
 * the type-in cards in 6502-DOCS write to `$9400`, so this is the window that
 * matters and the one an accessory occupies whole.
 *
 * An accessory is an ordinary `IO` card — nothing about the bus knows it is
 * special — plus the handful of facts needed to offer it in a dropdown and draw
 * it on screen. The registry that holds them is built in rather than user
 * supplied; see `registry.ts` for why that is a decision rather than a
 * limitation.
 */

/** A half-open-free address range: both ends are decoded. */
export interface AddressWindow {
  start: number
  end: number
}

/**
 * One circuit you can wire to the bus.
 *
 * The card itself is created on demand rather than held here, because fitting
 * one means building a new machine — you do not swap a breadboard with the power
 * on — and a shared instance would carry the old machine's latched state into
 * the new one.
 */
export interface AccessoryDefinition {
  /**
   * Stable identifier. Persisted in settings, accepted by `6502-kim run
   * --accessory`, and **the same string as the card's `IO.kind`**.
   *
   * One identifier rather than two on purpose: the slot-layout check in
   * `Snapshot.ts` compares slot kinds, so making the id the kind means a
   * snapshot taken with the LEDs fitted already refuses to restore into an empty
   * bay, with no accessory-specific code in the snapshot at all.
   */
  id: string

  /** What the dropdown calls it. */
  name: string

  /** One line, shown under the dropdown — what the circuit is, not how to use it. */
  description: string

  /** The window it answers on. Every accessory takes io6 whole. */
  window: AddressWindow

  /** The Vue component that draws it, by name — see `AccessoryPanel.vue`. */
  component: string

  /** Build one. Called once per machine, when the bay is fitted. */
  create(): IO
}
