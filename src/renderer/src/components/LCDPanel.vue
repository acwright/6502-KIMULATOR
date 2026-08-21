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
 * The panel is as wide as its region and however tall that makes it, with the
 * dot pitch snapped to whole device pixels so the grid stays crisp at any size.
 *
 * Width first, height derived — not a share of a column. The character area is
 * about four and a half times wider than it is tall, so a panel handed a column
 * to fill centred the display and left a band of empty panel above and below it
 * at every window size. The pad underneath grows into that height instead; it
 * is letterboxed to its own proportions, so it uses what it is given rather than
 * stretching. Double-clicking to expand is the one case that still fills a box,
 * because there the box is the window and filling it is the whole point.
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
  if (available.width < 8) return
  if (expanded.value && available.height < 8) return

  const dpr = window.devicePixelRatio || 1
  const columns = lcd.pixelsWidth
  const rows = lcd.pixelsHeight

  // Width and nothing else, unless the panel has been expanded to fill the
  // window. The box's height is this canvas's height everywhere else, so
  // measuring it would be measuring the previous frame.
  const pitch = fitPitch(
    columns,
    rows,
    available.width * dpr,
    expanded.value ? available.height * dpr : Number.POSITIVE_INFINITY
  )
  const { width, height } = panelSize(columns, rows, pitch)

  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
    // The CSS size has to follow the backing store, or the browser scales the
    // bitmap back up to the box and undoes the snapping.
    element.style.width = `${width / dpr}px`
    element.style.height = `${height / dpr}px`
    publishWidth(width / dpr)
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

/**
 * How wide the panel actually came out, for the pad to match.
 *
 * The two are one card and want one width, and a shared maximum is not enough to
 * give them one: the pitch is snapped to whole device pixels, so the display
 * rounds *down* from the cap by up to a pitch — 404 against 480 on a 1x screen —
 * and a pad at the full cap stood visibly wider than the display above it. The
 * rounding depends on the device pixel ratio, so no number written in CSS can
 * predict it; the only thing that knows is the draw that just happened.
 *
 * A custom property rather than shared state because the consumer is a CSS
 * `min()` in `GRID_STYLE`, and because it has to survive the pad being laid out
 * before this has drawn — which is what the fallback in that `min()` is for.
 */
function publishWidth(cssWidth: number): void {
  document.documentElement.style.setProperty('--lcd-width', `${cssWidth}px`)
}

let observer: ResizeObserver | undefined

onMounted(() => {
  frame = requestAnimationFrame(tick)
  if (root.value && typeof ResizeObserver !== 'undefined') {
    // Observing the box rather than the canvas: draw() sets the canvas's own
    // size, and observing that would feed itself.
    // Width only. In snug mode the box's height follows the canvas this draws,
    // so reacting to a height change would be reacting to the previous frame.
    let lastWidth = -1
    observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? -1
      if (width === lastWidth) return
      lastWidth = width
      stale = true
    })
    observer.observe(root.value)
  }
  window.addEventListener('keydown', onWindowKey, true)
})

onUnmounted(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  window.removeEventListener('keydown', onWindowKey, true)
  // With no display on screen there is no measured width, and the pad falls
  // back to the card's nominal one.
  document.documentElement.style.removeProperty('--lcd-width')
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
    class="flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-neutral-900 px-5 pt-3 pb-0"
    :class="expanded ? 'fixed inset-0 z-150 p-8' : 'shrink-0'"
    aria-label="LCD"
    :title="title"
    @dblclick="expanded = !expanded"
  >
    <div
      ref="root"
      class="flex w-full items-center justify-center"
      :class="expanded ? 'h-full' : 'lcd-cap'"
    >
      <canvas ref="canvas" class="block" />
    </div>
  </section>
</template>

<style scoped>
/*
  A limit on how big a 16 × 2 display gets to be.

  Deriving the height from the width is right until the width is a landscape
  phone's — 850 points across makes the panel 190 tall, which is more than half
  the window for two lines of text and leaves the pad with nothing. It is also
  simply wrong about the object: this is a part with a size, not something that
  grows to fill whatever it is put in. Past the cap the panel stays put and its
  region centres it.

  `--panel-width` and not a number of its own: the pad is held to the same
  width, because the two of them are one card.

  Expanding by double-click deliberately ignores this — that gesture exists to
  fill the window, and the reference screenshot it reproduces is why.
*/
.lcd-cap {
  max-width: var(--panel-width);
}

/*
  A box too narrow to draw the panel in at all is scaled into rather than cut
  off.

  `fitPitch` will not go below two device pixels per dot — under that the grid
  stops being a grid — so there is a width beneath which the panel simply does
  not fit, and without this it overflowed and lost its left-hand edge to the
  panel's `overflow-hidden`. Scaling costs the whole-pixel snapping and the
  display goes a little soft, which is a much smaller lie than showing fifteen
  of its sixteen columns.
*/
.lcd-cap canvas {
  max-width: 100%;
  height: auto;
}
</style>
