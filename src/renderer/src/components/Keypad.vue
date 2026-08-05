<script setup lang="ts">
/**
 * The 24-key pad on the Keypad Helper, laid out and coloured like the real one.
 *
 * Every cap comes out of `KeypadMap`, by way of `keypad/layout.ts` — the
 * position, the legend, and the encoder code the PIA actually sees. Nothing here
 * derives one from the other: the code is not the value printed on the cap (`0`
 * is $0A, and `C`–`F` run backwards), so a panel that computed its own codes
 * would be a second, quietly different description of the pad.
 *
 * Bebas Neue, hex keys black on white and function keys white on black, exactly
 * as the pad is legended. It is the one place the app departs from the
 * 6502-EMULATOR theme, because the hardware does.
 *
 * Mouse and keyboard converge on `store.pressKey(code)`. There is no release in
 * either direction — the MM74C922 latches the press and raises data-available,
 * and reports nothing at all when the key comes back up. The highlight below
 * follows the mouse and the host key because that is feedback for the person
 * pressing it, not a signal the machine ever sees.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import { ChevronUpIcon, ChevronLeftIcon, ChevronRightIcon } from '@heroicons/vue/24/solid'
import { keyForHostCode } from '@core/KeypadMap'
import { KEY_FACES, GRID_STYLE } from '@/keypad/layout'
import type { Arrow, KeyFace } from '@/keypad/layout'
import { useEmulatorStore } from '@/stores/emulator'
import { useFocusRegion } from '@/composables/useFocusRouter'

const store = useEmulatorStore()

const root = ref<HTMLElement | null>(null)
const { isFocused, take } = useFocusRegion('keypad', root, onKey)

/** Codes currently held down, for the highlight only. */
const held = ref(new Set<number>())

const hold = (code: number): void => {
  held.value = new Set(held.value).add(code)
}

const release = (code: number): void => {
  if (!held.value.has(code)) return
  const next = new Set(held.value)
  next.delete(code)
  held.value = next
}

function onKey(event: KeyboardEvent): boolean {
  const key = keyForHostCode(event.code)
  if (!key) return false
  // Auto-repeat is the host's, not the encoder's: a held key latches one code.
  if (!event.repeat) {
    store.pressKey(key.code)
    hold(key.code)
  }
  return true
}

function onWindowKeyUp(event: KeyboardEvent): void {
  const key = keyForHostCode(event.code)
  if (key) release(key.code)
}

/** Mouse clicks work regardless of focus, and take it on the way past. */
function onMouseDown(face: KeyFace): void {
  take()
  store.pressKey(face.code)
  hold(face.code)
}

onMounted(() => window.addEventListener('keyup', onWindowKeyUp, true))
onUnmounted(() => window.removeEventListener('keyup', onWindowKeyUp, true))

const ARROW_ICONS: Readonly<Record<Arrow, Component>> = {
  up: ChevronUpIcon,
  left: ChevronLeftIcon,
  right: ChevronRightIcon
}

const ringClass = computed(() =>
  isFocused.value ? 'outline outline-2 -outline-offset-2 outline-white/60' : 'outline-none'
)
</script>

<template>
  <section
    ref="root"
    tabindex="0"
    class="keypad-box flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-black p-3"
    :class="ringClass"
    aria-label="Keypad"
    @mousedown="take()"
    @focus="take()"
  >
    <div class="keypad-grid" :style="GRID_STYLE">
      <button
        v-for="face in KEY_FACES"
        :key="face.code"
        class="key"
        :class="[face.kind === 'hex' ? 'key-hex' : 'key-fn', { 'key-held': held.has(face.code) }]"
        :style="{ gridRow: face.row, gridColumn: face.column }"
        :title="`${face.label} — code ${face.hex}`"
        :aria-label="face.label"
        tabindex="-1"
        @mousedown.prevent="onMouseDown(face)"
        @mouseup="release(face.code)"
        @mouseleave="release(face.code)"
      >
        <component :is="ARROW_ICONS[face.arrow]" v-if="face.arrow" class="key-icon" />
        <span v-else class="key-label">{{ face.label }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* The panel the pad is letterboxed inside; GRID_STYLE does the arithmetic. */
.keypad-box {
  container-type: size;
}

.keypad-grid {
  display: grid;
  gap: 4%;
}

.key {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8%;
  /* Makes each cap a container, so the legend inside can be sized off the cap
     rather than off the window — a wide panel must not grow legends that
     overflow their own keys. */
  container-type: size;
  overflow: hidden;
  transition: transform 0.06s ease-out, filter 0.06s ease-out;
  user-select: none;
}

.key-label {
  font-family: 'Bebas Neue', system-ui, sans-serif;
  /* The caps are square, so this is 42% of the cap either way. PGUP and PGDN are
     the widest legends, and Bebas Neue is condensed enough to keep them inside. */
  font-size: 42cqh;
  line-height: 1;
  letter-spacing: 0.04em;
}

.key-icon {
  width: 40cqh;
  height: 40cqh;
}

/* The sixteen digits: black on white. */
.key-hex {
  background: #f2f2f2;
  color: #000;
}

/* The eight commands: white on black, with an edge so they still read as caps. */
.key-fn {
  background: #101010;
  color: #f2f2f2;
  border: 1px solid rgba(255, 255, 255, 0.35);
}

.key:hover {
  filter: brightness(1.15);
}

.key-held {
  transform: translateY(4%) scale(0.96);
  filter: brightness(0.8);
}
</style>
