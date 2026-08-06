<script setup lang="ts">
/**
 * Which panel the keyboard is talking to.
 *
 * A little keyboard in the corner of every panel that can take keys, lit on the
 * one holding them and dim on the rest. It replaces the ring the panels used to
 * draw around themselves: an outline reads as a selection, and the panels stand
 * for physical objects — an LCD and a keypad do not get selected. A lamp saying
 * "the keys go here" is the same information without the claim.
 *
 * Both states are always drawn. A badge that appeared only on the active panel
 * would tell you where the keyboard is but not that it can be moved.
 */
defineProps<{ active: boolean }>()
</script>

<template>
  <!-- Pointer-events off: the badge is an indicator, and clicking anywhere on
       the panel — including here — is what moves the keyboard. -->
  <div
    class="pointer-events-none absolute bottom-2 right-2 transition-colors duration-150"
    :class="active ? 'text-white' : 'text-neutral-700'"
    :aria-label="active ? 'Has keyboard focus' : 'Press Tab for keyboard focus'"
    :title="active ? 'The keyboard goes here — Tab to move it' : 'Tab, or click, to type here'"
  >
    <svg viewBox="0 0 24 24" class="size-5" fill="none" aria-hidden="true">
      <rect x="2.5" y="6.5" width="19" height="11" rx="2" stroke="currentColor" />
      <g fill="currentColor">
        <rect x="5" y="9" width="2" height="1.6" rx="0.4" />
        <rect x="8.5" y="9" width="2" height="1.6" rx="0.4" />
        <rect x="12" y="9" width="2" height="1.6" rx="0.4" />
        <rect x="15.5" y="9" width="2" height="1.6" rx="0.4" />
        <rect x="5" y="12" width="2" height="1.6" rx="0.4" />
        <rect x="8.5" y="12" width="5.5" height="1.6" rx="0.4" />
        <rect x="15.5" y="12" width="2" height="1.6" rx="0.4" />
      </g>
    </svg>
  </div>
</template>
