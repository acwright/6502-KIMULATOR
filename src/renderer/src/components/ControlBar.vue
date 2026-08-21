<script setup lang="ts">
/**
 * The strip beneath the panels: what you can do to the machine without opening
 * anything.
 *
 * Ported from 6502-EMULATOR with the KIM's button set. **Load Cart is not here
 * and is not anywhere** — the Keypad Card *is* the cartridge and it is soldered
 * into this machine's identity, so offering a slot would imply hardware that
 * does not exist. Load Program became Load Binary for the same kind of reason:
 * there is no BASIC to load a `.prg` into, only bytes at an address. Mute and
 * the joystick indicator went with the cards they reported on.
 *
 * **There is no clock switch either.** The ACE is the machine in the family with
 * the 2 MHz jumper; PHI2 on this board is 1 MHz, so a button offering to change
 * it would be offering hardware that does not exist.
 */
import { computed, ref } from 'vue'
import {
  PlayIcon,
  StopIcon,
  ArrowPathIcon,
  PowerIcon,
  CpuChipIcon,
  DocumentPlusIcon,
  ClipboardIcon,
  Cog6ToothIcon
} from '@heroicons/vue/24/solid'
import { useEmulatorStore } from '@/stores/emulator'
import { useConsole } from '@/composables/useConsole'
import KeyboardIcon from '@/components/KeyboardIcon.vue'
import type { NarrowView } from '@/composables/useNarrowLayout'

defineEmits<{
  'toggle-settings': []
  'toggle-paste': []
  'toggle-keyboard': []
  'show-view': [view: NarrowView]
}>()

const props = defineProps<{
  keyboardOpen?: boolean
  /** Which panel is showing — see useNarrowLayout. */
  view: NarrowView
  /**
   * Whether the window is showing one panel at a time.
   *
   * It decides how many ways the switch goes, not whether there is one. Wide,
   * the LCD and the pad are always on screen and only the left-hand column
   * takes turns, so the switch is the two panels that share it; narrow, the
   * machine is a third thing to choose.
   */
  narrow: boolean
}>()

/**
 * Wide, `machine` is not a choice — the machine is always there — so any view
 * that is not the bay is the terminal's turn in the column.
 */
const terminalActive = computed(() =>
  props.narrow ? props.view === 'terminal' : props.view !== 'bay'
)

const store = useEmulatorStore()
const term = useConsole()

/**
 * A machine halted by STP needs Reset, not Run — pressing Run gets a CPU that
 * cannot fetch another instruction. Saying so on the button is the smallest
 * honest signal; without it a halted machine is indistinguishable from a stopped
 * one, which is the state the same button claims it is in.
 */
const runTitle = computed(() => {
  if (store.isHalted) return 'Halted by STP — Reset to continue'
  return store.isRunning ? 'Stop' : 'Run'
})

function toggleRun(): void {
  if (store.isRunning) store.stop()
  else store.run()
}

/**
 * Switching the machine off and on again, terminal included.
 *
 * The console is a tap on the ACIA, not a device with its own memory, so nothing
 * makes it forget on its own — but a cold machine printing its splash underneath
 * the previous session's output reads as one session continuing. A real terminal
 * on the other end of the cable would still hold that text; this one is part of
 * the machine, and goes off with it.
 */
function powerCycle(): void {
  store.powerCycle()
  term.clear()
}

// ── Load ROM ──────────────────────────────────────────────────────────────────

const romInput = ref<HTMLInputElement | null>(null)

async function onLoadROM(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  store.loadROM(data, file.name)
  // The BIOS does not hold this machine's vectors, but a machine mid-Kernal with
  // half a new ROM under it is not a state worth preserving either.
  store.resetCPU()
}

// ── Load Binary ───────────────────────────────────────────────────────────────

/**
 * Bytes at an address — the type-in cards without the typing. Which address is
 * not guessable from the file, so the button asks before it opens the picker.
 */
const binaryInput = ref<HTMLInputElement | null>(null)
const prompting = ref(false)
const address = ref('0800')

/** Parsed hex load address, or null while the field is empty or out of RAM. */
const loadAddress = computed(() => {
  const text = address.value.trim().replace(/^(\$|0x)/i, '')
  if (!/^[0-9a-f]{1,4}$/i.test(text)) return null
  const value = parseInt(text, 16)
  return value < 0x8000 ? value : null
})

async function onLoadBinary(event: Event): Promise<void> {
  const target = loadAddress.value
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || target === null) return
  store.loadBinary(new Uint8Array(await file.arrayBuffer()), target, file.name)
  prompting.value = false
}
</script>

<template>
  <footer class="control-bar">
    <!--
      Which half of the machine is on screen, when there is not room for both.
      Absent entirely on a window wide enough to show all of it, because then it
      would be a switch between a thing and the same thing.
    -->
    <div class="view-switch" role="group" aria-label="View">
      <button
        v-if="narrow"
        :class="{ 'view-on': view === 'machine' }"
        title="The LCD and the pad — the machine itself"
        :aria-pressed="view === 'machine'"
        @click="$emit('show-view', 'machine')"
      >
        KIM
      </button>
      <button
        :class="{ 'view-on': terminalActive }"
        title="What the serial port sees"
        :aria-pressed="terminalActive"
        @click="$emit('show-view', 'terminal')"
      >
        TERM
      </button>
      <button
        :class="{ 'view-on': view === 'bay' }"
        title="The accessory bay — what is wired to the bus at $9400"
        :aria-pressed="view === 'bay'"
        @click="$emit('show-view', 'bay')"
      >
        BAY
      </button>
    </div>

    <!-- Load ROM — the BIOS is upstream and changes; pointing at a new build is routine. -->
    <button title="Load BIOS ROM" @click="romInput?.click()">
      <CpuChipIcon class="size-6" />
    </button>
    <input ref="romInput" type="file" accept=".bin,.rom" class="hidden" @change="onLoadROM" />

    <!-- Load Binary -->
    <button title="Load Binary (bytes at an address)" @click="prompting = !prompting">
      <DocumentPlusIcon class="size-6" />
    </button>
    <input ref="binaryInput" type="file" accept=".bin" class="hidden" @change="onLoadBinary" />

    <div class="h-6 w-px bg-white/20" />

    <!-- Run / Stop toggle -->
    <button :title="runTitle" :class="{ 'opacity-40': store.isHalted }" @click="toggleRun">
      <StopIcon v-if="store.isRunning" class="size-6" />
      <PlayIcon v-else class="size-6" />
    </button>

    <!-- Reset — pulses RESET only, so SRAM keeps whatever was keyed in. -->
    <button title="Reset (keeps RAM)" @click="store.reset()">
      <ArrowPathIcon class="size-6" />
    </button>

    <!-- Power cycle — a real KIM loses its RAM when you switch it off. -->
    <button title="Power Cycle (clears RAM)" @click="powerCycle">
      <PowerIcon class="size-6" />
    </button>

    <div class="h-6 w-px bg-white/20" />

    <!-- On-screen keyboard. Not a touch-only control: it is the only keyboard a
         phone has, and on a desktop it types at the terminal without taking the
         host's keyboard away from the pad. -->
    <button
      :class="{ 'text-indigo-400': keyboardOpen }"
      :title="keyboardOpen ? 'Hide keyboard' : 'Show keyboard'"
      :aria-pressed="keyboardOpen"
      @click="$emit('toggle-keyboard')"
    >
      <KeyboardIcon class="size-6" />
    </button>

    <button title="Paste Text" @click="$emit('toggle-paste')">
      <ClipboardIcon class="size-6" />
    </button>

    <button title="Settings" @click="$emit('toggle-settings')">
      <Cog6ToothIcon class="size-6" />
    </button>

    <!-- The address prompt, anchored above its button. -->
    <div
      v-if="prompting"
      class="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-2 rounded border border-white/15 bg-neutral-900 px-3 py-2 shadow-lg"
    >
      <label class="text-[10px] tracking-widest text-neutral-500">LOAD AT $</label>
      <input
        v-model="address"
        class="w-16 rounded border border-white/15 bg-white/5 px-2 py-1 text-center font-mono text-xs text-neutral-200 outline-none focus:border-white/35"
        spellcheck="false"
        placeholder="0800"
        title="Load address in hex — anywhere in RAM, $0000 to $7FFF"
        @keydown.enter="binaryInput?.click()"
        @keydown.esc="prompting = false"
      />
      <button
        class="rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-neutral-300 hover:bg-white/15 disabled:opacity-40"
        :disabled="loadAddress === null"
        @click="binaryInput?.click()"
      >
        Choose…
      </button>
    </div>
  </footer>
</template>

<style scoped>
/*
  Wraps rather than overflowing. A phone in portrait does not have room for the
  whole bar on one line, and a bar that runs off the right-hand edge takes
  Settings with it — the one control you need to get back out of whatever went
  wrong.
*/
.control-bar {
  position: relative;
  display: flex;
  flex-flow: row wrap;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 100%;
  box-sizing: border-box;
  gap: 0.5rem 1rem;
  padding: 0.5rem;
  /* Clear of the home indicator on a phone, and of nothing at all on a desktop,
     where the inset is zero. See index.html for `viewport-fit=cover`, which is
     what makes it non-zero. */
  padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
  border-top: 1px solid var(--color-neutral-800);
}

/*
  A 24px icon is a fine mouse target and a poor thumb one. Growing the button
  rather than the icon keeps the bar looking the same and makes it hittable;
  `pointer: coarse` leaves desktop density exactly as it was.
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
  On a short viewport the bar stops wrapping and scrolls sideways instead.

  Wrapping is right in portrait, where a second row costs nothing anyone wanted.
  In landscape a phone has about 340pt of page and this bar was taking a third of
  it in two rows of icons, which left the machine itself a strip. One row that
  scrolls trades a scroll gesture — for the controls past the edge, which are the
  ones you reach for least — against doubling the height the screen gets.
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
