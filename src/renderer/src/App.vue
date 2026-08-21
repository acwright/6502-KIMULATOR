<script setup lang="ts">
/**
 * The KIMulator window.
 *
 * Terminal top-left, LCD top-right, keys beneath the LCD, the accessory bay
 * beneath the terminal, control bar across the bottom. The two panels that stand
 * for physical objects — the LCD and the pad — keep their proportions as the
 * window resizes, because a stretched keypad or a squashed display is the one
 * distortion you notice immediately.
 *
 * Below 700px there is not room for two columns of that without squashing all
 * four, so the window shows the machine or the terminal, one at a time, with the
 * bay under both and a switch in the control bar — see useNarrowLayout.
 *
 * The keyboard goes to whichever panel you clicked; see useFocusRouter.
 */
import { onMounted, ref } from 'vue'
import { useSerial } from '@/composables/useSerial'
import { useConsole } from '@/composables/useConsole'
import { useDebugBridge } from '@/composables/useDebugBridge'
import { useMachine } from '@/composables/useMachine'
import { focus, useFocusRouter } from '@/composables/useFocusRouter'
import Terminal from '@/components/Terminal.vue'
import LCDPanel from '@/components/LCDPanel.vue'
import Keypad from '@/components/Keypad.vue'
import AccessoryPanel from '@/components/AccessoryPanel.vue'
import ControlBar from '@/components/ControlBar.vue'
import FocusBadge from '@/components/FocusBadge.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import PasteModal from '@/components/PasteModal.vue'
import OnScreenKeyboard from '@/components/OnScreenKeyboard.vue'
import { useNarrowLayout } from '@/composables/useNarrowLayout'

// Held here for the app's lifetime: the machine's serial link belongs to the
// machine, not to whichever panel happens to be open (see useSerial). The
// console is the same story — the Terminal panel draws it, but the debug
// protocol reads the same buffer whether that panel is mounted or not.
useSerial()
useConsole()

// Registers onUnmounted, so this must run during setup rather than from inside
// the async onMounted below — see useDebugBridge's own doc comment.
useDebugBridge()

const machine = useMachine()

const showSettings = ref(false)
const showPaste = ref(false)
const showKeyboard = ref(false)

const { narrow, view, show } = useNarrowLayout()

// The card's focus badge is drawn here rather than inside Keypad, because the
// panel it marks is the card — the display and the pad together — and the pad's
// own box is only part of it. See `.machine`.
const { focused } = useFocusRouter()

onMounted(async () => {
  await machine.boot()
  // The pad holds the keyboard to begin with, because the pad is the machine.
  // It is also what the KC Monitor's splash is waiting for: the terminal accepts
  // keys from the first frame, but nothing echoes until the firmware is past
  // that gate, so a window that started on the terminal looked broken. Clicking
  // the terminal — or Tab — moves it.
  focus('keypad')
})
</script>

<template>
  <!--
    The gaps between the panels are the dividers — the container's colour showing
    through. There is no padding around the outside on purpose: that drew a grey
    hairline down the window's left and right edges, which reads as a rendering
    fault rather than as a division between two panels.
  -->
  <div class="flex h-full flex-col bg-neutral-900 text-white">
    <!-- The panels and the keyboard together, so landscape can turn the two of
         them from a column into a row without the control bar joining in. -->
    <div class="stage">
    <!-- One panel at a time, when there is not room for two columns of them.
         Which one is the control bar's switch; see useNarrowLayout. -->
    <div v-if="narrow" class="panels flex min-h-0 flex-1 flex-col gap-px bg-neutral-800">
      <!-- The card: the display and the pad. A column, except in landscape,
           where they go side by side instead. See `.machine`. -->
      <div v-if="view === 'machine'" class="machine flex-1">
        <LCDPanel class="lcd-slot" />
        <Keypad class="keypad-slot" />
        <FocusBadge :active="focused === 'keypad'" />
      </div>
      <Terminal v-else-if="view === 'terminal'" class="flex-5" />

      <!-- The bay gets the whole panel here rather than a strip under one, so
           the dropdown and the circuit both have room. -->
      <AccessoryPanel v-else class="flex-1" />
    </div>

    <!--
      Two columns, each with its own split, rather than one two-by-two grid: the
      terminal wants most of the left column and the pad most of the right, and
      a shared row line would force one of them to give.
    -->
    <div v-else class="panels flex min-h-0 flex-1 gap-px bg-neutral-800">
      <!--
        The left column takes turns, the same way the whole window does when it
        is narrow: the terminal, or the accessory bay — the bus at $9400 and
        whatever is wired to it. An empty bay is what a KIM is with nothing
        plugged in.

        The bay used to be a strip under the terminal, which suited eight LEDs
        lying flat and would not suit a circuit of any height. As a column it has
        the same room the terminal does, and the terminal gets the whole column
        back when it is the one showing.
      -->
      <div class="flex min-w-0 flex-3 flex-col gap-px">
        <AccessoryPanel v-if="view === 'bay'" class="flex-1" />
        <Terminal v-else class="flex-1" />
      </div>

      <!-- The same card as the narrow layout's, in the right-hand column. -->
      <div class="machine flex-2">
        <LCDPanel class="lcd-slot" />
        <Keypad class="keypad-slot" />
        <FocusBadge :active="focused === 'keypad'" />
      </div>
    </div>

    <!-- Above the bar, not below it: the bar is where the toggle lives and the
         one piece of chrome that must not move when the keyboard comes up. -->
    <OnScreenKeyboard v-if="showKeyboard" />
    </div>

    <ControlBar
      :keyboard-open="showKeyboard"
      :view="view"
      :narrow="narrow"
      @toggle-settings="showSettings = !showSettings"
      @toggle-paste="showPaste = !showPaste"
      @toggle-keyboard="showKeyboard = !showKeyboard"
      @show-view="show"
    />

    <SettingsPanel v-if="showSettings" @close="showSettings = false" />
    <PasteModal v-if="showPaste" @close="showPaste = false" />
  </div>
</template>

<style scoped>
.stage {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

/*
  The Keypad LCD Helper: the display and the pad, as one thing.

  Centred together rather than each in the middle of its own half, and separated
  by `--card-gap` — the same space there is between two keycaps. No divider:
  every other seam in this window is a hairline of the container's colour showing
  between two panels, because those are separate things, and a line across this
  one would say it is two boards that happen to be stacked.
*/
.machine {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
  min-width: 0;
  gap: var(--card-gap);
  /* The focus badge is positioned against this corner, so this has to be what
     it is positioned against. Without it the badge resolved to the initial
     containing block and sat in the corner of the window instead. The band it
     needs is the pad's own bottom padding, which is why there is none here. */
  position: relative;
  /* Makes the card's own height the reference for `.lcd-slot`'s bound below. */
  container-type: size;
  /* The card carries the panel colour itself. Its two halves no longer fill it —
     that is what centring them means — so without this the container's divider
     colour showed through as a band above the display, a band below the pad, and
     a line between them: exactly the divider this is meant not to have. */
  background: var(--color-neutral-900);
}

/*
  The pad asks for the height its own width entitles it to — six rows of caps
  four across — rather than taking whatever is left over.

  That is what lets the pair be centred: with the pad filling the column there is
  no spare height to put above the display. `flex-shrink` still applies, so a
  column too short for the whole card squeezes the pad, and its grid letterboxes
  down inside it exactly as it did before. The `1.25rem` is the pad's own bottom
  padding, which the focus badge lives in.
*/
.machine > .keypad-slot {
  flex: 0 1 auto;
  height: calc(var(--lcd-width, var(--panel-width)) * 6 / 4 + 1.25rem);
}

/*
  How wide the display may be before the card is taller than the column.

  The pad follows the display's measured width, so the two agree — until the card
  does not fit, at which point the pad is the one that shrinks (it is the flexible
  one) and the display is left standing wider than it. Bounding the display by the
  height available fixes it at the other end: the card gets narrower, and the pad
  goes on matching it exactly.

  The card is `1.78 × W` tall plus about 34px of padding, from the display's
  101 : 23 face, the pad's 4 : 6, and the gap between them. That number only has
  to be an over-estimate, not the truth — err high and the display comes out a
  little smaller than it could be, which costs a few points and keeps the
  invariant. Err low and the pad shrinks and the widths part company again.
*/
.machine > .lcd-slot {
  width: 100%;
  max-width: calc((100cqh - 34px) / 1.78 + 2.5rem);
  /* Centred once the bound bites. A stretched flex item that cannot stretch sits
     at the start of the cross axis, which put the display a few points to the
     left of the pad — the one misalignment on a card whose whole point is that
     the two line up. */
  margin-inline: auto;
}

/*
  Landscape on a phone: the keyboard goes beside the panels, not under them.

  Stacked, the two of them divide about 290 points of height and the pad ends up
  a sliver — while several hundred points of width sit empty, because everything
  in this window is limited by height and nothing else. Side by side, both take
  that height instead of splitting it.

  Below 700px there is no width to do this with, so it stays a column. See
  OnScreenKeyboard for the board's half of the same breakpoint, and
  6502-EMULATOR's App.vue for the same rule over its screen.
*/
@media (max-height: 480px) and (min-width: 700px) {
  .stage {
    flex-direction: row;
  }

  .stage > .panels,
  .stage > .osk {
    flex: 1 1 0;
    min-width: 0;
  }

  /*
    The pad goes beside the display rather than under it, for the same reason
    the keyboard does. Stacked in a short row the pad is the one that suffers:
    it is four keys across and six down, so a hundred points of height makes it
    seventy points wide however much width is going spare. Side by side it gets
    the whole height and the keys come back to something a thumb can hit.
  */
  .machine {
    flex-direction: row;
  }

  /*
    Two fifths to the display, the rest to the pad — but never below 15rem.

    `fitPitch` will not go under two device pixels per dot, so a 16 × 2 panel has
    a width it cannot be drawn smaller than: about 226 points with its bezel and
    padding. Two fifths of a phone's landscape width with the keyboard open is
    less than that, and the panel was overflowing its box and being clipped down
    the left-hand edge. The floor is where the display stops giving way and the
    pad starts. The 30rem ceiling is the display's own cap.
  */
  .machine > .lcd-slot {
    flex: 0 0 clamp(15rem, 40%, 30rem);
    /* Side by side, the card's height is not the sum of the two — the bound
       above is about a column and does not apply. */
    max-width: none;
  }

  /* Side by side, the pad's height is the row's rather than its own. */
  .machine > .keypad-slot {
    flex: 1 1 0;
    height: auto;
  }
}
</style>
