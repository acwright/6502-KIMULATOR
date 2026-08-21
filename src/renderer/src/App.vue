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
import { focus } from '@/composables/useFocusRouter'
import Terminal from '@/components/Terminal.vue'
import MachineCard from '@/components/MachineCard.vue'
import AccessoryPanel from '@/components/AccessoryPanel.vue'
import ControlBar from '@/components/ControlBar.vue'
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
      <!-- The card: the display and the pad, drawn as one. See MachineCard. -->
      <MachineCard v-if="view === 'machine'" class="flex-1" />
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
      <MachineCard class="flex-2" />
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
  Landscape on a phone: the keyboard goes beside the panels, not under them.

  Stacked, the two of them divide about 290 points of height and the pad ends up
  a sliver — while several hundred points of width sit empty, because everything
  in this window is limited by height and nothing else. Side by side, both take
  that height instead of splitting it.

  Below 700px there is no width to do this with, so it stays a column. See
  OnScreenKeyboard for the board's half of the same breakpoint, MachineCard for
  the card's, and 6502-EMULATOR's App.vue for the same rule over its screen.
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
}
</style>
