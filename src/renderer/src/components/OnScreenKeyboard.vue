<script setup lang="ts">
/**
 * A 6502 keyboard, wired to the serial port.
 *
 * The same 67 caps in the same places as the ACE's — see `keyboard/layout.ts`,
 * which is kept identical with 6502-EMULATOR's copy. A KIM has no keyboard of
 * its own; this is the board you would wire to its serial line, and what it puts
 * on that line is what the AB Controller puts on it: capitals, Shift for the
 * symbols and the number row, and Ctrl+A…Ctrl+Z for $01–$1A.
 *
 * There is no phone-keyboard abstraction over it — no autocorrect, no lower
 * case, no symbol layers — because a keyboard that types something the KC
 * Monitor cannot read is worse than a small one. Four caps send nothing at all
 * (Caps Lock, Menu, Alt, Fn), which is what those switches do on the hardware.
 *
 * Not a mobile-only control. It is the only keyboard a phone has, and on a
 * desktop it is a way into the terminal that does not take the host's keyboard
 * away from the pad.
 */
import { computed, ref } from 'vue'
import { useConsole } from '@/composables/useConsole'
import { focus } from '@/composables/useFocusRouter'
import { BOARD_HEIGHT, BOARD_WIDTH, FUNCTION_ROW, KEY_CAPS, byteFor } from '@/keyboard/layout'
import type { KeyCap, Modifier } from '@/keyboard/layout'

const term = useConsole()

/**
 * A sticky modifier's three states, in the order tapping cycles them.
 *
 * `armed` survives exactly one key and then lets go, which is the only way to
 * type a shifted character with one finger. `locked` stays on until it is tapped
 * off — for a run of Ctrl codes, or the number row under Fn.
 */
type Latch = 'off' | 'armed' | 'locked'

const latches = ref<Record<Modifier, Latch>>({
  shift: 'off',
  ctrl: 'off',
  alt: 'off',
  fn: 'off'
})

const isDown = (modifier: Modifier): boolean => latches.value[modifier] !== 'off'

function cycle(modifier: Modifier): void {
  const next: Record<Latch, Latch> = { off: 'armed', armed: 'locked', locked: 'off' }
  latches.value = { ...latches.value, [modifier]: next[latches.value[modifier]] }
}

/** Armed lasts exactly one key. Locked stays on until it is tapped off. */
function disarm(): void {
  const cleared = { ...latches.value }
  for (const modifier of Object.keys(cleared) as Modifier[]) {
    if (cleared[modifier] === 'armed') cleared[modifier] = 'off'
  }
  latches.value = cleared
}

// ── What a cap is, right now ──────────────────────────────────────────────────

/**
 * Fn moves the number row to F1…F10 and leaves the rest of the board alone.
 *
 * The legends change; nothing goes on the wire. A function key is a matrix
 * position on the ACE, not a character, and there is no code for it to send.
 */
const functionRow = computed(() => (isDown('fn') ? FUNCTION_ROW : null))

function faceOf(cap: KeyCap): { legend: string; shifted?: string } {
  const fn = cap.row === 0 ? functionRow.value?.[cap.legend] : undefined
  if (fn) return { legend: fn.legend }
  return { legend: cap.legend, shifted: cap.shifted }
}

// ── Pressing ──────────────────────────────────────────────────────────────────

/**
 * Caps currently under a finger, for the highlight only.
 *
 * There is no release to send: this is a wire, not a matrix. A byte goes down it
 * when the cap goes down, and the cap coming back up is not an event the machine
 * has any way to hear about.
 */
const held = ref(new Set<KeyCap>())

function onPress(cap: KeyCap, event: PointerEvent): void {
  // Keeps the press from moving DOM focus off the terminal, and stops the
  // browser turning a held cap into a text selection or a long-press callout.
  event.preventDefault()

  if (cap.modifier) {
    cycle(cap.modifier)
    return
  }

  held.value = new Set(held.value).add(cap)

  // Under Fn the number row is F1…F10, and those have nothing to send.
  if (cap.row === 0 && functionRow.value?.[cap.legend]) return

  const byte = byteFor(cap, { shift: isDown('shift'), ctrl: isDown('ctrl') })
  if (byte !== null) {
    // The keys go to the terminal for as long as this board is up: a byte
    // arriving at the port is what this is, whatever the pad had before.
    focus('terminal')
    term.send(byte)
  }

  disarm()
}

function onRelease(cap: KeyCap): void {
  if (!held.value.has(cap)) return
  const next = new Set(held.value)
  next.delete(cap)
  held.value = next
}

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Each cap placed as a percentage of the board, with a fixed gutter taken out of
 * it. Percentages keep the layout exact at any size; the gutter is in pixels so
 * the channels between caps stay visible when the board is small.
 */
function place(cap: KeyCap): Record<string, string> {
  return {
    left: `calc(${(cap.x / BOARD_WIDTH) * 100}% + 1px)`,
    top: `calc(${(cap.row / BOARD_HEIGHT) * 100}% + 1px)`,
    width: `calc(${(cap.w / BOARD_WIDTH) * 100}% - 2px)`,
    height: `calc(${100 / BOARD_HEIGHT}% - 2px)`
  }
}

function classesFor(cap: KeyCap): Record<string, boolean> {
  return {
    'cap-dark': cap.dark === true,
    'cap-wide': cap.wide === true,
    'cap-held': held.value.has(cap),
    'cap-armed': cap.modifier !== undefined && latches.value[cap.modifier] === 'armed',
    'cap-locked': cap.modifier !== undefined && latches.value[cap.modifier] === 'locked',
    // Nothing goes down the wire for these, and saying so quietly beats a cap
    // that looks live and does nothing.
    'cap-mute': cap.modifier === undefined && cap.code === null
  }
}

/** What the cap is for, spelled out for a screen reader and a hover. */
function titleFor(cap: KeyCap): string {
  if (cap.modifier) return `${cap.legend} — tap to arm, again to lock`
  if (cap.code === null) return `${cap.legend} — a switch on the board; sends nothing`
  const face = faceOf(cap)
  if (face.shifted) return `${face.legend}, or ${face.shifted} with Shift`
  return face.legend || 'Space'
}
</script>

<template>
  <section class="osk" role="group" aria-label="On-screen keyboard" @contextmenu.prevent>
    <div class="board">
      <button
        v-for="(cap, index) in KEY_CAPS"
        :key="index"
        class="cap"
        :class="classesFor(cap)"
        :style="place(cap)"
        :title="titleFor(cap)"
        :aria-label="titleFor(cap)"
        :aria-pressed="cap.modifier ? latches[cap.modifier] !== 'off' : undefined"
        tabindex="-1"
        @pointerdown="onPress(cap, $event)"
        @pointerup="onRelease(cap)"
        @pointercancel="onRelease(cap)"
        @pointerleave="onRelease(cap)"
      >
        <!-- Both legends, as the cap is printed. The live one is the bright one:
             which half of the cap you get is the thing Shift changes. -->
        <span v-if="faceOf(cap).shifted" class="legend legend-pair">
          <span :class="{ dim: !isDown('shift') }">{{ faceOf(cap).shifted }}</span>
          <span :class="{ dim: isDown('shift') }">{{ faceOf(cap).legend }}</span>
        </span>
        <span v-else class="legend">{{ faceOf(cap).legend }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/*
  The board keeps its proportions and stops growing before it eats the window.

  `width: min(…)` rather than a height with `max-width` on it: a box that already
  has a definite height ignores its aspect ratio when the max-width clamps it, so
  the ratio has to come out of the arithmetic. The three terms are the room there
  is, the width at which the board would be `--osk-height` tall, and the width
  past which a desktop monitor is only making keycaps enormous.
*/
.osk {
  --osk-height: min(34dvh, 13rem);
  flex-shrink: 0;
  /* The board's width is measured against this, so it has to be a real width
     rather than whatever the caps happen to add up to. */
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  background: #0f0f0f;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.board {
  position: relative;
  width: min(100%, calc(var(--osk-height) * 16.5 / 5), 56rem);
  aspect-ratio: 16.5 / 5;
  margin: 0 auto;
  /* Makes the board the reference for the legends, so a cap's legend is sized
     off the board rather than off the window. */
  container-type: size;
  /* A tap must never scroll the page, zoom it, select a legend, or raise the
     long-press callout — all four of which a keyboard would otherwise do. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.cap {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0;
  overflow: hidden;
  background: #cccccc;
  color: #000;
  transition: transform 0.05s ease-out, filter 0.05s ease-out;
}

/* Esc, Enter, Space and the arrows. */
.cap-dark {
  background: #393b3b;
  color: #f7f2ea;
}

/* Caps Lock, Menu, Alt and Fn: real switches that send nothing. */
.cap-mute {
  background: #9a9a9a;
  color: #3a3a3a;
}

.legend {
  /* The caps are one unit tall, so this is ~40% of a cap. */
  font-size: 8cqh;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* A word or an arrow has to fit across a cap barely wider than a letter's. */
.cap-wide .legend {
  font-size: 5cqh;
  font-weight: 500;
}

/* Two legends stacked, upper one first, exactly as the cap is printed. */
.legend-pair {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2em;
  font-size: 5.6cqh;
}

.legend-pair .dim {
  opacity: 0.45;
}

.cap:hover {
  filter: brightness(1.12);
}

.cap-held {
  transform: translateY(4%) scale(0.97);
  filter: brightness(0.82);
}

/* Armed lasts one key; locked stays on. Two states, told apart by how loud they
   are, because "this applies once" and "this is stuck on" are different promises. */
.cap-armed {
  background: #6366f1;
  color: #fff;
}

.cap-locked {
  background: #6366f1;
  color: #fff;
  box-shadow: inset 0 0 0 2px #fff;
}

/*
  Beside the panels rather than under them — App.vue's `.stage` turns the column
  into a row at the same breakpoint, and this is the board's half of that.

  The height is the row's now, so the board is measured against its own box
  instead of against `--osk-height`. Same arithmetic either way: as wide as
  fits, or as wide as its height entitles it to be, whichever is smaller.
*/
@media (max-height: 480px) and (min-width: 700px) {
  .osk {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 6px;
    border-top: none;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    /* A definite height, so `100cqh` below is a length the board can use. */
    container-type: size;
  }

  .board {
    width: min(100%, calc(100cqh * 16.5 / 5));
  }
}
</style>
