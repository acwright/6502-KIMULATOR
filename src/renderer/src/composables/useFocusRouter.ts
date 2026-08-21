import { computed, ref, onUnmounted, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * Which panel the keyboard is talking to.
 *
 * The machine really does have two independent input paths — the serial port and
 * the pad — and on the real thing you choose between them by moving your hands.
 * So there is no global mode here either: you click the panel you mean, it takes
 * the keyboard and shows a ring, and `Tab` cycles. Nothing to remember, and
 * nothing that can be left switched the wrong way.
 *
 * One `keydown` listener, at the window, so exactly one thing decides where a
 * key went. It prevents the default only for keys the focused panel actually
 * consumed, which is what keeps browser and Electron shortcuts working while the
 * terminal has the keyboard.
 */

export type Region = 'terminal' | 'keypad'

/** Tab order, and the order the ring moves in. */
const ORDER: readonly Region[] = ['terminal', 'keypad']

interface Registration {
  /** The panel's own element, so focus can be moved onto it. */
  element: HTMLElement
  /** Handle a key. Return true if the panel consumed it. */
  onKey: (event: KeyboardEvent) => boolean
}

const regions = new Map<Region, Registration>()
const focused = ref<Region | null>(null)

let listeners = 0

/**
 * Typing in the Settings panel, the Paste box or any other field is not input to
 * the machine. Without this, keying an address into the Load Binary box would
 * also be keying it into the monitor.
 */
function isEditing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable
}

function onWindowKeyDown(event: KeyboardEvent): void {
  // Fullscreen belongs to the window rather than to whatever holds the keyboard,
  // so it is answered before anything is routed anywhere — but only where there
  // is a window to answer for. In the browser build F11 is the *browser's*
  // fullscreen key, and swallowing it there would take the shortcut away and
  // give nothing back.
  if (event.key === 'F11' || (event.metaKey && event.key === 'Enter')) {
    if (!window.api) return
    event.preventDefault()
    window.api.window.toggleFullscreen()
    return
  }

  if (isEditing(event.target)) return

  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    cycle(event.shiftKey ? -1 : 1)
    return
  }

  const registration = focused.value ? regions.get(focused.value) : undefined
  if (registration?.onKey(event)) event.preventDefault()
}

function cycle(step: number): void {
  const available = ORDER.filter((region) => regions.has(region))
  if (available.length === 0) return

  const current = focused.value ? available.indexOf(focused.value) : -1
  const index = (current + step + available.length) % available.length
  focus(available[index]!)
}

/**
 * Give a panel the keyboard, moving DOM focus with it so the ring follows.
 *
 * A region that is not on the screen is not a place keys can go, so pointing at
 * one does nothing at all rather than lighting its badge and dropping every
 * keystroke into it. That case is ordinary rather than exotic: the embed's
 * `panels=` can leave the pad out of a frame entirely, and the narrow layout
 * unmounts whichever panel is not the one showing.
 */
export function focus(region: Region): void {
  const registration = regions.get(region)
  if (!registration) return
  focused.value = region
  registration.element.focus({ preventScroll: true })
}

/** Whether a region is mounted and able to take the keyboard. */
export function hasRegion(region: Region): boolean {
  return regions.has(region)
}

/**
 * Claim a region for the calling component, for as long as it is mounted.
 *
 * Call from `<script setup>`: it registers `onUnmounted`, which Vue only accepts
 * during a component's synchronous setup.
 */
export function useFocusRegion(
  region: Region,
  element: Ref<HTMLElement | null>,
  onKey: (event: KeyboardEvent) => boolean
): { isFocused: ComputedRef<boolean>; take: () => void } {
  if (listeners++ === 0) window.addEventListener('keydown', onWindowKeyDown, true)

  // The template ref is null until the component mounts, so registration
  // follows it rather than happening once here.
  const stop = watch(
    element,
    (el) => {
      if (el) regions.set(region, { element: el, onKey })
      else regions.delete(region)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    stop()
    regions.delete(region)
    if (focused.value === region) focused.value = null
    if (--listeners === 0) window.removeEventListener('keydown', onWindowKeyDown, true)
  })

  return {
    isFocused: computed(() => focused.value === region),
    take: () => focus(region)
  }
}

/** The region holding the keyboard, for anything that wants to know. */
export function useFocusRouter(): { focused: Ref<Region | null>; focus: typeof focus } {
  return { focused, focus }
}
