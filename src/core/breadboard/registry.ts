import type { IO } from '../IO'
import type { CircuitDefinition, AddressWindow } from './Circuit'
import { LEDLatch } from './LEDLatch'

/**
 * Everything you can wire to IO6.
 *
 * Built in, not user supplied. The interface a circuit has to satisfy is
 * deliberately small — an `IO` card and five fields — so opening it up to
 * plug-ins later is a decision someone takes, rather than a rewrite they have to
 * fund first. Until there is a reason to, a closed list is one fewer surface to
 * keep compatible.
 *
 * The list is the only description of what is fitted anywhere: settings store an
 * id out of it, `6502-kim run --breadboard` takes one, the Settings panel and the
 * breadboard panel both offer it, and the card's own `IO.kind` *is* that id. A
 * circuit added here needs nothing added anywhere else.
 */

/** io6, `$9400–$97FF`. A circuit takes the slot whole. */
export const IO6_WINDOW: AddressWindow = { start: 0x9400, end: 0x97ff }

export const CIRCUITS: readonly CircuitDefinition[] = [
  {
    id: LEDLatch.ID,
    name: 'KIM Demo — 8 LEDs',
    description:
      'Eight LEDs behind a 74HC373 latch. A write anywhere in the window lights ' +
      'them; reads are open bus, so the BIOS does not mistake it for a VIA.',
    window: IO6_WINDOW,
    component: 'LEDLatchView',
    create: () => new LEDLatch()
  }
]

/**
 * The definition an id names, or undefined for an empty breadboard.
 *
 * Undefined rather than a throw for an id this build has never heard of: a
 * settings file written by a later version should leave the breadboard empty and boot,
 * not refuse to open a window.
 */
export function circuitFor(id: string | null | undefined): CircuitDefinition | undefined {
  if (!id) return undefined
  return CIRCUITS.find((circuit) => circuit.id === id)
}

/** A fresh card for the breadboard, or undefined to leave it vacant. */
export function createCircuit(id: string | null | undefined): IO | undefined {
  return circuitFor(id)?.create()
}

/**
 * The definition describing a card that is already on the bus.
 *
 * Goes through `kind` because that is the id — which is what lets the panel
 * draw whatever the machine was actually built with, rather than trusting a
 * separately-held selection to still agree with it.
 */
export function circuitOf(card: IO | null | undefined): CircuitDefinition | undefined {
  return card ? circuitFor(card.kind) : undefined
}
