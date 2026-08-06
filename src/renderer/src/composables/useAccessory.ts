import { computed } from 'vue'
import { ACCESSORIES, accessoryOf } from '@core/accessories/registry'
import { useEmulatorStore } from '@/stores/emulator'
import { useMachine } from '@/composables/useMachine'

/**
 * What is wired to the accessory bus, and changing it.
 *
 * Shared by the bay in the window and the ACCESSORY section in Settings, which
 * are two views of one choice — a dropdown in each that could disagree would be
 * worse than either alone.
 *
 * What is *fitted* is read back off the machine rather than from a remembered
 * selection. The machine is the thing being described, and after a rebuild it is
 * the only thing that knows what actually went in: an id from a settings file
 * this build does not recognise leaves the bay empty, and the panel should then
 * say empty rather than name a circuit that is not there.
 */
export function useAccessory() {
  const store = useEmulatorStore()
  const machine = useMachine()

  /** The card on the bus, or null for an empty bay. */
  const card = computed(() => store.getAccessory())

  /** Its registry entry — name, description, and the component that draws it. */
  const fitted = computed(() => accessoryOf(card.value))

  /** What the dropdowns show. The empty string is the empty bay. */
  const selected = computed(() => fitted.value?.id ?? '')

  /**
   * Wire something else in.
   *
   * Rebuilds the machine and warm-starts it: you do not swap a circuit on the
   * bus with the power on, and a new machine is what pulling the board and
   * powering back up actually gives you. Which is also why this is a no-op when
   * nothing changed — reselecting what is already fitted should not clear RAM.
   */
  function fit(id: string | null): void {
    const next = id || null
    if (next === (selected.value || null)) return

    machine.rebuild({ accessory: next })
    window.api?.settings.set({ accessory: next }).catch(() => {})
  }

  return { options: ACCESSORIES, card, fitted, selected, fit }
}
