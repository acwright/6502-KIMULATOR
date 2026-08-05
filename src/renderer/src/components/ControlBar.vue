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

defineEmits<{ 'toggle-settings': []; 'toggle-paste': [] }>()

const store = useEmulatorStore()

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

function toggleFrequency(): void {
  const next = store.frequency === 1_000_000 ? 2_000_000 : 1_000_000
  store.setFrequency(next)
  window.api?.settings.set({ frequency: next }).catch(() => {})
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
  <footer class="relative flex shrink-0 flex-row items-center justify-center gap-4 border-t border-neutral-800 py-2">
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
    <button title="Power Cycle (clears RAM)" @click="store.powerCycle()">
      <PowerIcon class="size-6" />
    </button>

    <div class="h-6 w-px bg-white/20" />

    <button
      class="rounded border border-white/30 px-2 py-0.5 font-mono text-sm tabular-nums transition-colors hover:border-white/60"
      :title="store.frequency === 1_000_000 ? 'Switch to 2 MHz' : 'Switch to 1 MHz'"
      @click="toggleFrequency"
    >
      {{ store.frequency === 1_000_000 ? '1 MHz' : '2 MHz' }}
    </button>

    <div class="h-6 w-px bg-white/20" />

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
