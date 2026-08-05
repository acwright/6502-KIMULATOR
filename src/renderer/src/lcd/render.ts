/**
 * How the LCD is drawn.
 *
 * Kept out of `LCDPanel.vue` for the same reason the terminal's control codes
 * and the pad's layout are: this is the part with a right answer, and the right
 * answer is a picture. `docs/reference/lcd-reference.png` is the only surviving
 * record of the original renderer and therefore the specification, and the way
 * to check a renderer against a photograph is to draw a real pixel buffer with
 * it and look at the two side by side. That is only possible if the drawing is
 * something other than a component.
 *
 * **The dot grid is always visible.** This is the whole effect and the thing a
 * naive renderer gets wrong. Every pixel position in every character cell is
 * drawn — unlit ones a shade darker than the backlight, lit ones nearly black.
 * A panel that draws only the lit pixels reads as green text on green; this one
 * reads as a *display*, because you can see the matrix it is written on even
 * where nothing is written.
 *
 * The numbers were measured off the reference rather than estimated: over 1,904
 * blank 6 × 6 tiles containing no lit pixel, the darkest dot against the
 * brightest backlight in the same tile averages 0.80 and medians 0.77. It is a
 * much stronger grid than "a shade darker" suggests, and it is why the matrix
 * reads so clearly. Blur in the photograph can only have pulled the two
 * *together*, so if anything the real contrast was higher still.
 *
 * The reference is a photograph of a screen, though: it carries the camera's
 * white balance, is upscaled 2×, and is blurred enough that the dot geometry
 * beyond the 6:1 cell-to-dot ratio could not be recovered. Treat the hex values
 * as a calibrated starting point and the *ratios* as the specification.
 *
 * Straight on. No perspective, no rotation, no glare, no reflection, no
 * scanlines, no vignette. The reference is angled because it is a photograph,
 * and its brightness falls off toward the bottom-right for the same reason —
 * #94AC45 at the shadowed end against #B0C95B at the lit one. The panel itself
 * is uniform.
 */

/** Uniform warm yellow-green. No gradient, no hotspot. */
export const BACKLIGHT = '#AFC85A'

/** ~78% of the backlight's luminance. Present in every cell position. */
export const DOT_UNLIT = '#8AA33B'

/** Near-black with an olive cast, never pure black. */
export const DOT_LIT = '#101B04'

/**
 * Gutter between dots within a cell, as a fraction of the dot pitch.
 *
 * Measured off the reference rather than taken from the estimate: scanning
 * horizontally through a character row, dark runs come out at ~4 px and the
 * gaps between them at ~2-4 px against a 6.99 px pitch, which is a gutter
 * around 30% and a dot around 70% — not the 20% that was guessed from looking.
 *
 * It is the difference between a display and a chequerboard. At 20% the unlit
 * dots very nearly touch and blank cells read as solid blocks; at 30% each dot
 * is distinct with backlight visible all round it, which is the texture the
 * photograph actually has.
 */
export const DOT_GUTTER = 0.3

/** Corner softening, as a fraction of the dot. Square, not circular. */
export const DOT_RADIUS = 0.15

/**
 * Backlight around the character area, in dot pitches. The glass extends well
 * past the text.
 *
 * Measured off the reference, which is 98.4 × 23.2 pitches of panel around a
 * 95 × 17 character area: 3.1 pitches top and bottom, but only 1.7 at the sides.
 * The two disagree because that panel was stretched to fill its window rather
 * than keeping the character area's aspect ratio, so the horizontal figure is
 * the window's shape and not the design. The vertical one is the design, and it
 * is taken here for all four sides.
 */
export const BEZEL_PITCHES = 3

/** Panel corner rounding, in dot pitches. */
export const PANEL_RADIUS_PITCHES = 2

/** What the panel measures, given a character area and a dot pitch. */
export function panelSize(
  columns: number,
  rows: number,
  pitch: number
): { width: number; height: number } {
  return {
    width: pitch * (columns + BEZEL_PITCHES * 2),
    height: pitch * (rows + BEZEL_PITCHES * 2)
  }
}

/**
 * The largest whole-pixel dot pitch whose panel fits in the given box.
 *
 * Whole pixels because a fractional pitch puts dots half a pixel apart and the
 * grid — the entire effect — goes soft.
 */
export function fitPitch(
  columns: number,
  rows: number,
  boxWidth: number,
  boxHeight: number
): number {
  return Math.max(
    2,
    Math.floor(
      Math.min(
        boxWidth / (columns + BEZEL_PITCHES * 2),
        boxHeight / (rows + BEZEL_PITCHES * 2)
      )
    )
  )
}

/**
 * Draw a panel showing `pixels`, an `LCDAttachment` buffer of `columns` ×
 * `rows`, where each value is -1 for the inter-character gap, 0 for an unlit dot
 * and 1 for a lit one.
 *
 * Assumes the context has already been sized to `panelSize(...)`.
 */
export function drawPanel(
  context: CanvasRenderingContext2D,
  pixels: ArrayLike<number>,
  columns: number,
  rows: number,
  pitch: number
): void {
  const { width, height } = panelSize(columns, rows, pitch)

  // The glass: uniform backlight, softly rounded corners.
  context.clearRect(0, 0, width, height)
  context.fillStyle = BACKLIGHT
  context.beginPath()
  context.roundRect(0, 0, width, height, pitch * PANEL_RADIUS_PITCHES)
  context.fill()

  const dot = Math.max(1, Math.round(pitch * (1 - DOT_GUTTER)))
  const inset = Math.floor((pitch - dot) / 2)
  const radius = Math.max(0.5, dot * DOT_RADIUS)
  const origin = pitch * BEZEL_PITCHES

  // Two passes so the fill style is set twice rather than 1,615 times.
  for (const lit of [false, true]) {
    context.fillStyle = lit ? DOT_LIT : DOT_UNLIT
    context.beginPath()
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        // -1 is the inter-character gap: one full dot pitch of backlight between
        // cells and between rows, drawn by leaving it alone.
        const state = pixels[y * columns + x] ?? -1
        if (state < 0 || (state === 1) !== lit) continue
        context.roundRect(origin + x * pitch + inset, origin + y * pitch + inset, dot, dot, radius)
      }
    }
    context.fill()
  }
}
