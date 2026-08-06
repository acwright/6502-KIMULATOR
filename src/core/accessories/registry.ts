import type { IO } from '../IO'
import type { AccessoryDefinition, AddressWindow } from './Accessory'
import { LEDLatch } from './LEDLatch'

/**
 * Everything you can wire to the accessory bus.
 *
 * Built in, not user supplied. The interface an accessory has to satisfy is
 * deliberately small — an `IO` card and five fields — so opening it up to
 * plug-ins later is a decision someone takes, rather than a rewrite they have to
 * fund first. Until there is a reason to, a closed list is one fewer surface to
 * keep compatible.
 *
 * The list is the only description of what is fitted anywhere: settings store an
 * id out of it, `6502-kim run --accessory` takes one, the Settings panel and the
 * bay both offer it, and the card's own `IO.kind` *is* that id. An accessory
 * added here needs nothing added anywhere else.
 */

/** io6, `$9400–$97FF`. An accessory takes the slot whole. */
export const ACCESSORY_WINDOW: AddressWindow = { start: 0x9400, end: 0x97ff }

export const ACCESSORIES: readonly AccessoryDefinition[] = [
  {
    id: LEDLatch.ID,
    name: 'KIM Demo — 8 LEDs',
    description:
      'Eight LEDs behind a 74HC373 latch. A write anywhere in the window lights ' +
      'them; reads are open bus, so the BIOS does not mistake it for a VIA.',
    window: ACCESSORY_WINDOW,
    component: 'LEDLatchView',
    create: () => new LEDLatch()
  }
]

/**
 * The definition an id names, or undefined for an empty bay.
 *
 * Undefined rather than a throw for an id this build has never heard of: a
 * settings file written by a later version should leave the bay empty and boot,
 * not refuse to open a window.
 */
export function accessoryFor(id: string | null | undefined): AccessoryDefinition | undefined {
  if (!id) return undefined
  return ACCESSORIES.find((accessory) => accessory.id === id)
}

/** A fresh card for the bay, or undefined to leave it vacant. */
export function createAccessory(id: string | null | undefined): IO | undefined {
  return accessoryFor(id)?.create()
}

/**
 * The definition describing a card that is already on the bus.
 *
 * Goes through `kind` because that is the id — which is what lets the panel
 * draw whatever the machine was actually built with, rather than trusting a
 * separately-held selection to still agree with it.
 */
export function accessoryOf(card: IO | null | undefined): AccessoryDefinition | undefined {
  return card ? accessoryFor(card.kind) : undefined
}
