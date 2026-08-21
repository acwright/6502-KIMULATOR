<script setup lang="ts">
/**
 * What the serial port sees, in both directions.
 *
 * Not a second device — a tap on the ACIA byte stream (see useConsole). Bytes
 * the machine transmits are drawn here *and* go down a real cable when one is
 * connected; bytes typed here are delivered exactly as bytes arriving from a
 * real port would be. Connect a laptop and both views show the same traffic,
 * which is what "follows exactly what the serial port sees" means.
 *
 * Drawn as a screen rather than as a text box: a fixed 320 × 240 raster with the
 * 40 × 24 characters in the middle of it and overscan around them, in the ACE's
 * own character generator, scaled up whole to whatever room the panel has. The
 * arithmetic is in `terminal/render.ts`; what is left here is the canvas, the
 * keyboard and the two buttons.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { ClipboardIcon, CheckIcon, TrashIcon } from '@heroicons/vue/24/solid'
import { useConsole } from '@/composables/useConsole'
import { useFocusRegion } from '@/composables/useFocusRouter'
import FocusBadge from '@/components/FocusBadge.vue'
import { byteForKey } from '@/terminal/keys'
import { SCREEN_HEIGHT, SCREEN_WIDTH, drawScreen } from '@/terminal/render'

const term = useConsole()

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

const { isFocused, take } = useFocusRegion('terminal', root, onKey)

/** A key the terminal claims becomes a byte on the wire; anything else is left alone. */
function onKey(event: KeyboardEvent): boolean {
  const byte = byteForKey(event)
  if (byte === null) return false
  term.send(byte)
  return true
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/**
 * The raster, built once. The canvas is a fixed 320 × 240 and CSS does the
 * scaling, so there is nothing here that a resize changes.
 */
let image: ImageData | undefined
let pixels: Uint32Array | undefined

function draw(): void {
  const element = canvas.value
  if (!element) return
  const context = element.getContext('2d')
  if (!context) return

  if (!image || !pixels) {
    image = context.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT)
    pixels = new Uint32Array(image.data.buffer)
  }

  // The cursor only while the panel holds the keyboard — an unfocused terminal
  // showing a cursor is claiming keys it will not receive.
  drawScreen(pixels, term.buffer.screen(), isFocused.value ? term.buffer.cursor : null)
  context.putImageData(image, 0, 0)
}

/**
 * One redraw per animation frame, and only when something changed.
 *
 * At 19200 baud the machine can produce ~1900 characters a second; redrawing per
 * byte would ask for thirty times the frames a screen can show.
 */
let frame = 0
let lastDrawn = -1
let lastFocused = false

function tick(): void {
  if (term.buffer.version !== lastDrawn || isFocused.value !== lastFocused) {
    lastDrawn = term.buffer.version
    lastFocused = isFocused.value
    draw()
  }
  frame = requestAnimationFrame(tick)
}

onMounted(() => {
  draw()
  frame = requestAnimationFrame(tick)
})

onUnmounted(() => {
  cancelAnimationFrame(frame)
  clearTimeout(copiedTimer)
})

// ── Copy and clear ────────────────────────────────────────────────────────────

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(term.buffer.text())
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 1200)
  } catch {
    /* no clipboard permission — nothing useful to say about it */
  }
}

/** Wipes the panel and the scrollback. Nothing about the machine changes. */
function clear(): void {
  term.clear()
}
</script>

<template>
  <section
    ref="root"
    tabindex="0"
    class="terminal-box group relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-neutral-900 p-5 outline-none"
    aria-label="Terminal"
    @mousedown="take()"
    @focus="take()"
  >
    <!-- Height first, aspect ratio derives the width, max-width handles a narrow
         window. The canvas is 320 × 240 whatever this comes out at. -->
    <div class="screen">
      <canvas ref="canvas" :width="SCREEN_WIDTH" :height="SCREEN_HEIGHT" />
    </div>

    <div class="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
      <button
        class="rounded p-1 text-neutral-600 transition hover:text-white focus:opacity-100"
        :title="copied ? 'Copied' : 'Copy terminal text'"
        @click.stop="copy"
      >
        <CheckIcon v-if="copied" class="size-4" />
        <ClipboardIcon v-else class="size-4" />
      </button>

      <button
        class="rounded p-1 text-neutral-600 transition hover:text-white focus:opacity-100"
        title="Clear terminal"
        @click.stop="clear"
      >
        <TrashIcon class="size-4" />
      </button>
    </div>

    <FocusBadge :active="isFocused" />
  </section>
</template>

<style scoped>
/* Makes the panel's content box the reference for the tube below. */
.terminal-box {
  container-type: size;
}

/*
  The tube: as large as fits, at 4:3, whichever way the panel is shaped.

  `width: min(100%, height × 4/3)` rather than a height with `max-width` on it,
  because clamping a box that already has a definite height only squashes it —
  the ratio has to come out of the arithmetic, not out of a fallback.
*/
.screen {
  width: min(100%, calc(100cqh * 4 / 3));
  aspect-ratio: 320 / 240;
  border-radius: 0.5rem;
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.screen canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* Whole pixels, scaled up. Anything else blurs a 5 × 8 glyph into a smudge. */
  image-rendering: pixelated;
}
</style>
