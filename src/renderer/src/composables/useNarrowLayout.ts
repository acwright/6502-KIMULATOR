import { nextTick, onUnmounted, readonly, ref } from 'vue'
import type { DeepReadonly, Ref } from 'vue'
import { focus } from '@/composables/useFocusRouter'

/**
 * What to do when the window cannot hold the whole machine at once.
 *
 * The four panels assume two columns: the terminal and the accessory bay down
 * one side, the LCD and the pad down the other. On a phone in portrait that
 * gives every one of them about a third of the room it needs — a keypad you
 * cannot hit, and an LCD too small to read, which is the one distortion you
 * notice immediately.
 *
 * So below the threshold the window shows one of them at a time: the machine
 * itself — the LCD and the pad — the terminal, or the accessory bay.
 *
 * The bay is a view rather than a strip under one, and that holds at every size.
 * Squeezed beneath a panel it had room for a dropdown or a circuit but not both,
 * which was fine for eight LEDs lying flat and will not be fine for the next
 * accessory. Wide, the card keeps the right-hand column and the terminal and the
 * bay share the left one; narrow, all three take turns. Either way the bay gets
 * a whole panel when it is the one being looked at.
 *
 * Two columns need a window that is wider than it is tall, and big enough in
 * both directions. All three parts of that matter:
 *
 *   • Width, obviously. Below 700px there is no room for two of anything.
 *   • Height, for the same reason and less obviously. A phone in landscape is
 *     844 across — wide enough — and 390 tall, which after the control bar
 *     leaves the LCD and the pad a hundred points to share. Two columns are
 *     only two columns if there is room down them.
 *   • Shape. An iPad in portrait clears both bounds and still reads badly: a
 *     4:3 terminal in a tall half-width column is a small picture with a field
 *     of black over and under it, and the same again on the other side. The
 *     panels want width, and in portrait there is only enough for one of them
 *     at a time.
 */

export type NarrowView = 'machine' | 'terminal' | 'bay'

const QUERY = '(max-width: 700px), (max-height: 480px), (orientation: portrait)'

export function useNarrowLayout(): {
  narrow: DeepReadonly<Ref<boolean>>
  view: DeepReadonly<Ref<NarrowView>>
  show: (next: NarrowView) => void
} {
  // `matchMedia` and not a resize listener, so this and the stylesheet cannot
  // disagree about where the threshold is.
  const media = window.matchMedia(QUERY)
  const narrow = ref(media.matches)

  // The pad, to begin with, because the pad is the machine — the same reason
  // App.vue hands it the keyboard on boot.
  const view = ref<NarrowView>('machine')

  const onChange = (event: MediaQueryListEvent): void => {
    narrow.value = event.matches
  }
  media.addEventListener('change', onChange)
  onUnmounted(() => media.removeEventListener('change', onChange))

  /**
   * Show a view, and give it the keyboard.
   *
   * The panel that is on screen is the one keys should go to — on a window this
   * narrow there is no second panel to mean instead. The focus has to wait for
   * the render: the region being switched to does not exist until Vue has
   * mounted it, and the one being switched away from deregisters as it goes.
   *
   * The bay is not a region and takes no keys. Its dropdown takes focus when it
   * is used, and the focus router leaves fields alone. What the keyboard should
   * do instead depends on what else is on screen: wide, the pad is still there
   * and should have the keys the terminal just gave up; narrow, nothing that
   * takes keys is mounted at all, and the router clears itself as they unmount.
   */
  const show = (next: NarrowView): void => {
    view.value = next
    if (next === 'bay') {
      if (!narrow.value) void nextTick(() => focus('keypad'))
      return
    }
    void nextTick(() => focus(next === 'machine' ? 'keypad' : 'terminal'))
  }

  return { narrow: readonly(narrow), view: readonly(view), show }
}
