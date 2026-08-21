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
 *
 * Two things here are not about operating the machine at all. The view switch is
 * what makes a frame narrower than two columns usable — without it a phone gets
 * four panels at a third the size each. The keyboard is the machine's only way
 * of taking serial input on a touch device. Both are the reader's, not the
 * author's: `panels=` and `keyboard=` decide what the frame starts as, and these
 * decide what it is showing right now.
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
import KeyboardIcon from '@/components/KeyboardIcon.vue'
import type { ControlsMode } from '@/embed/params'
import type { NarrowView } from '@/composables/useNarrowLayout'

const props = defineProps<{
  mode: ControlsMode
  fullscreen: boolean
  keyboardOpen?: boolean
  /** Whether there is an ACIA for the board to type into. See `serialcard=`. */
  keyboardAvailable?: boolean
  /** Which panel is in front — see useNarrowLayout. */
  view: NarrowView
  /** The views this frame can be switched between. Empty means it cannot. */
  views: readonly NarrowView[]
  /** Whether the frame is showing one panel at a time. */
  narrow: boolean
}>()

defineEmits<{
  'toggle-fullscreen': []
  'toggle-keyboard': []
  'show-view': [view: NarrowView]
}>()

/**
 * The buttons the switch actually gets.
 *
 * Wide, the card is always on screen — it is the right-hand column — so it is
 * not a thing to switch *to*, and the switch is whatever shares the left column.
 * Narrow it is one of the choices like any other.
 *
 * Fewer than two and there is nothing to choose, so the switch is not drawn at
 * all rather than offering a button that goes where you already are.
 */
const switchViews = computed<NarrowView[]>(() => {
  if (props.views.length < 2) return []
  const available = props.views.filter((view) => props.narrow || view !== 'machine')
  return available.length > 1 ? [...available] : []
})

/**
 * Wide, `machine` is not a choice — the card is always there — so any view that
 * is not the bay is the terminal's turn in the column.
 */
const terminalActive = computed(() =>
  props.narrow ? props.view === 'terminal' : props.view !== 'bay'
)

const VIEW_LABELS: Readonly<Record<NarrowView, string>> = {
  machine: 'KIM',
  terminal: 'TERM',
  bay: 'BAY'
}

const VIEW_TITLES: Readonly<Record<NarrowView, string>> = {
  machine: 'The LCD and the pad — the machine itself',
  terminal: 'What the serial port sees',
  bay: 'The accessory bay — what is wired to the bus at $9400'
}

const isActive = (view: NarrowView): boolean =>
  view === 'terminal' ? terminalActive.value : props.view === view

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
  <footer class="control-bar">
    <!--
      Which panel is in front, when the frame cannot show them all at once.
      Absent when there is nothing to choose between; see `switchViews`.
    -->
    <div v-if="switchViews.length" class="view-switch" role="group" aria-label="View">
      <button
        v-for="option in switchViews"
        :key="option"
        :class="{ 'view-on': isActive(option) }"
        :title="VIEW_TITLES[option]"
        :aria-pressed="isActive(option)"
        @click="$emit('show-view', option)"
      >
        {{ VIEW_LABELS[option] }}
      </button>
    </div>

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

    <!-- On-screen keyboard: the board you would wire to this machine's serial
         line. Absent on a frame built with `serialcard=0`, where there is no
         ACIA for a byte to arrive at and the button would do nothing. -->
    <button
      v-if="keyboardAvailable"
      :class="{ 'text-indigo-400': keyboardOpen }"
      :title="keyboardOpen ? 'Hide keyboard' : 'Show keyboard'"
      :aria-pressed="keyboardOpen"
      @click="$emit('toggle-keyboard')"
    >
      <KeyboardIcon class="size-5" />
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

<style scoped>
/*
  Wraps rather than overflowing — the same rule as the full app's ControlBar,
  which is where the reasoning is written down. A bar that runs off the edge of
  the frame takes its rightmost controls with it, and in an embed those are the
  keyboard and fullscreen: the two a reader on a phone most needs.
*/
.control-bar {
  position: relative;
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  /* The frame stretches its children, so this is a real width to wrap against. */
  width: 100%;
  box-sizing: border-box;
  gap: 0.5rem 1rem;
  padding: 0.375rem 0.5rem;
  /* Clear of the home indicator when this page is opened top-level on a phone,
     and of nothing at all inside an iframe or on a desktop, where the inset is
     zero. See embed.html for `viewport-fit=cover`, which is what makes it
     non-zero. */
  padding-bottom: calc(0.375rem + env(safe-area-inset-bottom));
  border-top: 1px solid var(--color-neutral-800);
}

/*
  A 20px icon is a fine mouse target and a poor thumb one. Growing the button
  rather than the icon keeps the bar looking the same and makes it hittable;
  `pointer: coarse` keeps desktop density exactly as it was.
*/
@media (pointer: coarse) {
  .control-bar > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.75rem;
    min-height: 2.75rem;
  }
}

.view-switch {
  display: flex;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  overflow: hidden;
}

.view-switch button {
  padding: 0.25rem 0.6rem;
  font-family: monospace;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #999;
  background: transparent;
}

.view-switch button + button {
  border-left: 1px solid rgba(255, 255, 255, 0.2);
}

.view-switch .view-on {
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}

/*
  On a short frame the bar stops wrapping and scrolls sideways instead. Wrapping
  is right in portrait, where a second row costs nothing anyone wanted; in
  landscape it was taking a third of the height and leaving the panels a strip.
*/
@media (max-height: 480px) {
  .control-bar {
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    /* Keeps a sideways flick from turning into a page scroll or a bounce. */
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .control-bar::-webkit-scrollbar {
    display: none;
  }

  /* Nothing may collapse to make room; running off the end is the point. */
  .control-bar > * {
    flex-shrink: 0;
  }
}
</style>
