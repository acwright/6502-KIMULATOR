<script setup lang="ts">
/**
 * The embed's control bar: the three things a reader of someone else's page
 * plausibly wants — run, reset and fullscreen — plus power cycle under
 * `controls=full`.
 *
 * Everything that implies a session of your own belongs to the full app: the
 * settings panel, the serial port, the paste box, and both file pickers. An
 * embed's machine is described by its URL, and a button that loaded a file from
 * the reader's disk into a frame on someone else's article would be answering a
 * question nobody asked.
 *
 * Where 6502-EMULATOR's version has a mute button and a clock toggle, this one
 * has neither, and for the same reason as the full app's control bar: there is
 * no sound card on this machine and PHI2 on this board is 1 MHz.
 */
import { computed } from 'vue'
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  PowerIcon,
  ArrowsPointingOutIcon,
  ArrowsPointingInIcon
} from '@heroicons/vue/24/solid'
import { useEmulatorStore } from '@/stores/emulator'
import { useConsole } from '@/composables/useConsole'
import type { ControlsMode } from '@/embed/params'

defineProps<{ mode: ControlsMode; fullscreen: boolean }>()

defineEmits<{ 'toggle-fullscreen': [] }>()

const store = useEmulatorStore()
const term = useConsole()

/**
 * A machine halted by STP needs Reset, not Run — pressing Run gets a CPU that
 * cannot fetch another instruction.
 */
const runTitle = computed(() => {
  if (store.isHalted) return 'Halted by STP — Reset to continue'
  return store.isRunning ? 'Stop' : 'Run'
})

function toggleRun(): void {
  if (store.isRunning) store.stop()
  else store.run()
}

/** Switching the machine off and on again, terminal included — see ControlBar. */
function powerCycle(): void {
  store.powerCycle()
  term.clear()
}
</script>

<template>
  <footer
    class="flex shrink-0 flex-row items-center justify-center gap-4 border-t border-neutral-800 py-1.5"
  >
    <button :title="runTitle" :class="{ 'opacity-40': store.isHalted }" @click="toggleRun">
      <StopIcon v-if="store.isRunning" class="size-5" />
      <PlayIcon v-else class="size-5" />
    </button>

    <!-- Reset — pulses RESET only, so SRAM keeps whatever was keyed in. -->
    <button title="Reset (keeps RAM)" @click="store.reset()">
      <ArrowPathIcon class="size-5" />
    </button>

    <!-- Power cycle — a real KIM loses its RAM when you switch it off. -->
    <button v-if="mode === 'full'" title="Power Cycle (clears RAM)" @click="powerCycle">
      <PowerIcon class="size-5" />
    </button>

    <!-- Fullscreen — owned by EmbedApp, which holds the element to expand. -->
    <button
      :title="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
      @click="$emit('toggle-fullscreen')"
    >
      <ArrowsPointingInIcon v-if="fullscreen" class="size-5" />
      <ArrowsPointingOutIcon v-else class="size-5" />
    </button>
  </footer>
</template>
