<script setup lang="ts">
/**
 * The Keypad LCD Helper: the display and the pad, as one thing.
 *
 * Centred together rather than each in the middle of its own half, and separated
 * by `--card-gap` — the same space there is between two keycaps. No divider:
 * every other seam in this window is a hairline of the container's colour showing
 * between two panels, because those are separate things, and a line across this
 * one would say it is two boards that happen to be stacked.
 *
 * A component and not a pair of panels in a `<div>`, because there are three
 * places that draw the card — App.vue's narrow layout, its wide one, and the
 * embed — and the arithmetic below is what makes the display and the pad come
 * out the same width. Three copies of it would be three chances for them to
 * disagree, which is exactly the bug this card was drawn to fix.
 *
 * The focus badge belongs here rather than inside Keypad: the panel it marks is
 * the card, and the pad's own box is only part of it.
 */
import LCDPanel from '@/components/LCDPanel.vue'
import Keypad from '@/components/Keypad.vue'
import FocusBadge from '@/components/FocusBadge.vue'
import { useFocusRouter } from '@/composables/useFocusRouter'

const { focused } = useFocusRouter()
</script>

<template>
  <div class="machine">
    <LCDPanel class="lcd-slot" />
    <Keypad class="keypad-slot" />
    <FocusBadge :active="focused === 'keypad'" />
  </div>
</template>

<style scoped>
.machine {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
  min-width: 0;
  gap: var(--card-gap);
  /* The focus badge is positioned against this corner, so this has to be what
     it is positioned against. Without it the badge resolved to the initial
     containing block and sat in the corner of the window instead. The band it
     needs is the pad's own bottom padding, which is why there is none here. */
  position: relative;
  /* Makes the card's own height the reference for `.lcd-slot`'s bound below. */
  container-type: size;
  /* The card carries the panel colour itself. Its two halves no longer fill it —
     that is what centring them means — so without this the container's divider
     colour showed through as a band above the display, a band below the pad, and
     a line between them: exactly the divider this is meant not to have. */
  background: var(--color-neutral-900);
}

/*
  The pad asks for the height its own width entitles it to — six rows of caps
  four across — rather than taking whatever is left over.

  That is what lets the pair be centred: with the pad filling the column there is
  no spare height to put above the display. `flex-shrink` still applies, so a
  column too short for the whole card squeezes the pad, and its grid letterboxes
  down inside it exactly as it did before. The `1.25rem` is the pad's own bottom
  padding, which the focus badge lives in.
*/
.machine > .keypad-slot {
  flex: 0 1 auto;
  height: calc(var(--lcd-width, var(--panel-width)) * 6 / 4 + 1.25rem);
}

/*
  How wide the display may be before the card is taller than the column.

  The pad follows the display's measured width, so the two agree — until the card
  does not fit, at which point the pad is the one that shrinks (it is the flexible
  one) and the display is left standing wider than it. Bounding the display by the
  height available fixes it at the other end: the card gets narrower, and the pad
  goes on matching it exactly.

  The card is `1.78 × W` tall plus about 34px of padding, from the display's
  101 : 23 face, the pad's 4 : 6, and the gap between them. That number only has
  to be an over-estimate, not the truth — err high and the display comes out a
  little smaller than it could be, which costs a few points and keeps the
  invariant. Err low and the pad shrinks and the widths part company again.
*/
.machine > .lcd-slot {
  width: 100%;
  max-width: calc((100cqh - 34px) / 1.78 + 2.5rem);
  /* Centred once the bound bites. A stretched flex item that cannot stretch sits
     at the start of the cross axis, which put the display a few points to the
     left of the pad — the one misalignment on a card whose whole point is that
     the two line up. */
  margin-inline: auto;
}

/*
  Landscape: the pad goes beside the display rather than under it, for the same
  reason the keyboard goes beside the panels. Stacked in a short row the pad is
  the one that suffers — it is four keys across and six down, so a hundred points
  of height makes it seventy points wide however much width is going spare. Side
  by side it gets the whole height and the keys come back to something a thumb
  can hit.

  The same breakpoint as `.stage`'s in App.vue and EmbedApp.vue, because it is
  the same window shape.
*/
@media (max-height: 480px) and (min-width: 700px) {
  .machine {
    flex-direction: row;
  }

  /*
    Two fifths to the display, the rest to the pad — but never below 15rem.

    `fitPitch` will not go under two device pixels per dot, so a 16 × 2 panel has
    a width it cannot be drawn smaller than: about 226 points with its bezel and
    padding. Two fifths of a phone's landscape width with the keyboard open is
    less than that, and the panel was overflowing its box and being clipped down
    the left-hand edge. The floor is where the display stops giving way and the
    pad starts. The 30rem ceiling is the display's own cap.
  */
  .machine > .lcd-slot {
    flex: 0 0 clamp(15rem, 40%, 30rem);
    /* Side by side, the card's height is not the sum of the two — the bound
       above is about a column and does not apply. */
    max-width: none;
  }

  /* Side by side, the pad's height is the row's rather than its own. */
  .machine > .keypad-slot {
    flex: 1 1 0;
    height: auto;
  }
}
</style>
