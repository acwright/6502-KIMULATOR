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
 * The keyboard goes to whichever panel you clicked; see useFocusRouter.
 */
import { onMounted, ref } from 'vue'
import { useSerial } from '@/composables/useSerial'
import { useConsole } from '@/composables/useConsole'
import { useDebugBridge } from '@/composables/useDebugBridge'
import { useMachine } from '@/composables/useMachine'
import { focus } from '@/composables/useFocusRouter'
import Terminal from '@/components/Terminal.vue'
import LCDPanel from '@/components/LCDPanel.vue'
import Keypad from '@/components/Keypad.vue'
import ControlBar from '@/components/ControlBar.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import PasteModal from '@/components/PasteModal.vue'

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

onMounted(async () => {
  await machine.boot()
  // Something has to hold the keyboard to begin with, and the serial console is
  // where a machine with a Serial Card in it is usually driven from. Clicking
  // the pad — or Tab — moves it.
  focus('terminal')
})
</script>

<template>
  <div class="flex h-full flex-col bg-black text-white">
    <!--
      Two columns, each with its own split, rather than one two-by-two grid: the
      terminal wants most of the left column and the pad most of the right, and
      a shared row line would force one of them to give.
    -->
    <div class="flex min-h-0 flex-1 gap-px bg-neutral-800 p-px">
      <div class="flex min-w-0 flex-3 flex-col gap-px">
        <Terminal class="flex-4" />

        <!-- The accessory bay. The registry of circuits arrives with the
             accessories; an empty bay is what a KIM is with nothing wired in. -->
        <section
          class="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center bg-black"
          aria-label="Accessory"
        >
          <h1 class="text-sm tracking-[0.3em] text-neutral-600">ACCESSORY</h1>
          <p class="mt-1 font-mono text-xs text-neutral-700">the bus at $9400 — empty</p>
        </section>
      </div>

      <div class="flex min-w-0 flex-2 flex-col gap-px">
        <LCDPanel class="flex-2" />
        <Keypad class="flex-3" />
      </div>
    </div>

    <ControlBar @toggle-settings="showSettings = !showSettings" @toggle-paste="showPaste = !showPaste" />

    <SettingsPanel v-if="showSettings" @close="showSettings = false" />
    <PasteModal v-if="showPaste" @close="showPaste = false" />
  </div>
</template>

<style scoped>
.kim-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  grid-template-rows: 3fr 2fr;
  grid-template-areas:
    'terminal lcd'
    'accessory keys';
}
</style>
