<script setup lang="ts">
/**
 * The 16 × 2 HD44780 on the Keypad LCD Helper, drawn as a real dot-matrix panel.
 *
 * The drawing itself — the colours, the dot geometry, the bezel, and the
 * reasoning behind every number in it — is in `lcd/render.ts`, so it can be
 * pointed at a real pixel buffer and compared against
 * `docs/reference/lcd-reference.png` without a window. What is left here is the
 * part that needs one: fitting the panel to its box, and expanding it.
 *
 * The panel fills its region keeping the character area's aspect ratio, with the
 * dot pitch snapped to whole device pixels so the grid stays crisp at any size.
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { drawPanel, fitPitch, panelSize } from '@/lcd/render'

const store = useEmulatorStore()

const root = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

/**
 * Double-click expands the panel to fill the window — which is exactly the
 * reference screenshot, and the reason that screenshot exists.
 */
const expanded = ref(false)

function onWindowKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && expanded.value) {
    expanded.value = false
    event.stopPropagation()
  }
}

// ── Fitting ───────────────────────────────────────────────────────────────────

function draw(): void {
  const element = canvas.value
  const box = root.value
  if (!element || !box) return
  const context = element.getContext('2d')
  if (!context) return

  const lcd = store.getLCD()
  if (!lcd) return

  const available = box.getBoundingClientRect()
  if (available.width < 8 || available.height < 8) return

  const dpr = window.devicePixelRatio || 1
  const columns = lcd.pixelsWidth
  const rows = lcd.pixelsHeight

  const pitch = fitPitch(columns, rows, available.width * dpr, available.height * dpr)
  const { width, height } = panelSize(columns, rows, pitch)

  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
    // The CSS size has to follow the backing store, or the browser scales the
    // bitmap back up to the box and undoes the snapping.
    element.style.width = `${width / dpr}px`
    element.style.height = `${height / dpr}px`
  }

  drawPanel(context, lcd.buffer, columns, rows, pitch)
}

/**
 * Redraw only when the panel has actually changed.
 *
 * The buffer is 95 × 17 and cheap to compare; rebuilding 1,600 rounded rects
 * sixty times a second for a display that changes on a keypress is not.
 */
let frame = 0
let previous: Int8Array | null = null
let stale = true

function tick(): void {
  const lcd = store.getLCD()
  // Blink lives in the controller, not in here: tick() advances its phase but
  // only a write rebuilds the buffer, so the frame asks for a rebuild before
  // reading it. Cursor and blink then arrive as lit pixels like anything else.
  lcd?.updatePixels()
  const buffer = lcd?.buffer

  if (stale || !buffer || !previous || previous.length !== buffer.length || !equal(previous, buffer)) {
    stale = false
    if (buffer) previous = Int8Array.from(buffer)
    draw()
  }

  frame = requestAnimationFrame(tick)
}

function equal(a: Int8Array, b: Int8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

let observer: ResizeObserver | undefined

onMounted(() => {
  frame = requestAnimationFrame(tick)
  if (root.value && typeof ResizeObserver !== 'undefined') {
    // Observing the box rather than the canvas: draw() sets the canvas's own
    // size, and observing that would feed itself.
    observer = new ResizeObserver(() => (stale = true))
    observer.observe(root.value)
  }
  window.addEventListener('keydown', onWindowKey, true)
})

onUnmounted(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  window.removeEventListener('keydown', onWindowKey, true)
})

// Expanding moves the canvas into a different box; nothing about the buffer
// changed, so the comparison above would otherwise skip the frame that redraws it.
watch(expanded, () => (stale = true))

const title = computed(() =>
  expanded.value ? 'Double-click to shrink (Esc)' : 'Double-click to expand'
)
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-black p-3"
    :class="expanded ? 'fixed inset-0 z-150 p-8' : ''"
    aria-label="LCD"
    :title="title"
    @dblclick="expanded = !expanded"
  >
    <div ref="root" class="flex h-full w-full items-center justify-center">
      <canvas ref="canvas" class="block" />
    </div>
  </section>
</template>
