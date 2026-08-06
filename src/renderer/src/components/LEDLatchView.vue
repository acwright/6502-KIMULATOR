<script setup lang="ts">
/**
 * The KIM Demo's eight LEDs.
 *
 * Bit 7 leftmost, bit 0 rightmost, and the byte in hex beneath — the order and
 * the notation both come from the type-in cards in 6502-DOCS, so what someone
 * reads off this panel matches what the card told them to expect. That ordering
 * is `accessory/leds.ts`, tested, because it is the one thing here that can be
 * wrong rather than merely ugly.
 *
 * The latch is polled rather than watched: nothing in the core is reactive, and
 * a program can rewrite the lamps far faster than a frame.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { LEDLatch } from '@core/accessories/LEDLatch'
import { lamps, readout } from '@/accessory/leds'

const props = defineProps<{ card: LEDLatch }>()

const byte = ref(props.card.byte)

let frame = 0

function tick(): void {
  byte.value = props.card.byte
  frame = requestAnimationFrame(tick)
}

onMounted(() => (frame = requestAnimationFrame(tick)))
onUnmounted(() => cancelAnimationFrame(frame))

const row = computed(() => lamps(byte.value))
const hex = computed(() => readout(byte.value))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col items-center justify-center gap-2">
    <div class="flex items-end gap-3">
      <div v-for="lamp in row" :key="lamp.bit" class="flex flex-col items-center gap-1">
        <span class="lamp" :class="{ 'lamp-lit': lamp.lit }" />
        <span class="lamp-bit">{{ lamp.bit }}</span>
      </div>
    </div>

    <span class="readout">{{ hex }}</span>
  </div>
</template>

<style scoped>
/*
  A 5 mm red LED on a breadboard: dark and slightly translucent when off, and
  when lit, bright in the middle with the light spilling past the rim. The glow
  is what makes a running program legible at a glance — a flat colour change
  reads as a checkbox, not as a lamp.
*/
.lamp {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #3a1010;
  border: 1px solid rgba(255, 255, 255, 0.12);
  transition: background 0.05s linear, box-shadow 0.05s linear;
}

.lamp-lit {
  background: #ff3b30;
  border-color: rgba(255, 140, 130, 0.8);
  box-shadow: 0 0 6px rgba(255, 59, 48, 0.9), 0 0 14px rgba(255, 59, 48, 0.45);
}

/* Which bit drives it, so the cards' "$80 is the leftmost" is on the panel. */
.lamp-bit {
  font-family: monospace;
  font-size: 9px;
  line-height: 1;
  color: #555;
}

.readout {
  font-family: monospace;
  font-size: 12px;
  color: #888;
}
</style>
