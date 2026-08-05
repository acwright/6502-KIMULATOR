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
 * 40 × 24, white on black, drawn on a canvas so the cell grid can be snapped to
 * whole device pixels at any window size.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ClipboardIcon, CheckIcon } from '@heroicons/vue/24/solid'
import { useConsole } from '@/composables/useConsole'
import { useFocusRegion } from '@/composables/useFocusRouter'
import { byteForKey } from '@/terminal/keys'
import { TERMINAL_COLS, TERMINAL_ROWS } from '@/terminal/TerminalBuffer'

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

const FOREGROUND = '#e8e8e8'
const BACKGROUND = '#000000'

/**
 * Cell proportions. A monospace face at this size advances close enough to half
 * its line height that snapping both to whole pixels keeps the columns aligned
 * without measuring every glyph.
 */
const CELL_ASPECT = 0.5

function draw(): void {
  const element = canvas.value
  const box = root.value
  if (!element || !box) return
  const context = element.getContext('2d')
  if (!context) return

  const dpr = window.devicePixelRatio || 1
  const available = box.getBoundingClientRect()
  if (available.width < 8 || available.height < 8) return

  // Snap the cell to whole device pixels and size the canvas to the grid rather
  // than to the box. A fractional cell puts columns half a pixel apart and the
  // whole screen goes soft.
  const cell = Math.max(
    4,
    Math.floor(
      Math.min(
        (available.width * dpr) / TERMINAL_COLS / CELL_ASPECT,
        (available.height * dpr) / TERMINAL_ROWS
      )
    )
  )
  const advance = Math.max(2, Math.round(cell * CELL_ASPECT))
  const width = advance * TERMINAL_COLS
  const height = cell * TERMINAL_ROWS

  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
    // The CSS size has to follow the backing store, or the browser scales the
    // bitmap back up to the box and undoes every bit of the snapping above.
    element.style.width = `${width / dpr}px`
    element.style.height = `${height / dpr}px`
  }

  context.fillStyle = BACKGROUND
  context.fillRect(0, 0, width, height)

  context.font = `${cell}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
  context.textBaseline = 'alphabetic'

  const rows = term.buffer.screen()
  // Sits the glyph in the cell: most of a monospace face's height is above the
  // baseline, and the descender wants what is left.
  const baseline = Math.round(cell * 0.78)

  context.fillStyle = FOREGROUND
  for (let row = 0; row < rows.length; row++) {
    const text = rows[row]!
    const y = row * cell + baseline
    for (let column = 0; column < text.length; column++) {
      const character = text[column]!
      if (character !== ' ') context.fillText(character, column * advance, y)
    }
  }

  // Block cursor, only while the panel holds the keyboard — an unfocused
  // terminal showing a cursor is claiming keys it will not receive.
  if (!isFocused.value) return

  const { row, column } = term.buffer.cursor
  if (row < 0 || row >= TERMINAL_ROWS) return

  const x = column * advance
  const y = row * cell
  context.fillStyle = FOREGROUND
  context.fillRect(x, y, advance, cell)

  // Knock the character back out of the block, so a cursor sitting on a glyph
  // reads as an inverse cell rather than hiding it.
  const character = rows[row]?.[column] ?? ' '
  if (character !== ' ') {
    context.fillStyle = BACKGROUND
    context.fillText(character, x, y + baseline)
  }
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
let resized = true

function tick(): void {
  if (resized || term.buffer.version !== lastDrawn || isFocused.value !== lastFocused) {
    resized = false
    lastDrawn = term.buffer.version
    lastFocused = isFocused.value
    draw()
  }
  frame = requestAnimationFrame(tick)
}

let observer: ResizeObserver | undefined

onMounted(() => {
  frame = requestAnimationFrame(tick)
  if (root.value && typeof ResizeObserver !== 'undefined') {
    // A resize changes no content, so the revision check above would skip it.
    // Observing the box rather than the canvas: draw() sets the canvas's own
    // size, and observing that would feed itself.
    observer = new ResizeObserver(() => (resized = true))
    observer.observe(root.value)
  }
})

onUnmounted(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  clearTimeout(copiedTimer)
})

// ── Copy ──────────────────────────────────────────────────────────────────────

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

const ringClass = computed(() =>
  isFocused.value ? 'outline outline-2 -outline-offset-2 outline-white/60' : 'outline-none'
)
</script>

<template>
  <section
    ref="root"
    tabindex="0"
    class="group relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-black"
    :class="ringClass"
    aria-label="Terminal"
    @mousedown="take()"
    @focus="take()"
  >
    <canvas ref="canvas" class="block" />

    <button
      class="absolute right-2 top-2 rounded p-1 text-neutral-600 opacity-0 transition hover:text-white focus:opacity-100 group-hover:opacity-100"
      :title="copied ? 'Copied' : 'Copy terminal text'"
      @click.stop="copy"
    >
      <CheckIcon v-if="copied" class="size-4" />
      <ClipboardIcon v-else class="size-4" />
    </button>
  </section>
</template>
