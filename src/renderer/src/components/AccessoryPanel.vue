<script setup lang="ts">
/**
 * The accessory bay — the bus at $9400, and whatever is wired to it.
 *
 * A dropdown of the registered circuits and the selected one's own component.
 * It makes no attempt to look like a breadboard: the LCD and the pad stand for
 * physical objects and are drawn as such, but this panel stands for *a slot*,
 * and a photorealistic breadboard would claim a particular circuit that the
 * registry is explicitly not committed to.
 *
 * Changing the selection rebuilds the machine and warm-starts it — see
 * `useAccessory`. Swapping a circuit on the bus with the power on is not a thing
 * you do.
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import { useAccessory } from '@/composables/useAccessory'
import LEDLatchView from '@/components/LEDLatchView.vue'

const { options, card, fitted, selected, fit } = useAccessory()

/**
 * The registry names its component as a string, because the registry is core and
 * knows nothing about Vue. This is the one place that mapping is resolved, so an
 * accessory added to the registry has exactly one line to add here.
 */
const VIEWS: Readonly<Record<string, Component>> = {
  LEDLatchView
}

/** Nothing to draw until the machine actually has the card on the bus. */
const view = computed(() => (fitted.value ? VIEWS[fitted.value.component] : undefined))

function onSelect(event: Event): void {
  fit((event.target as HTMLSelectElement).value || null)
}
</script>

<template>
  <section
    class="flex min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-900"
    aria-label="Accessory"
  >
    <!-- No heading. None of the other panels carry one, and the dropdown
         already says what this is. -->
    <div class="flex shrink-0 items-center gap-3 px-3 pt-2">
      <select
        class="accessory-select"
        :value="selected"
        title="What is wired to the bus at $9400. Changing it switches the machine off and on."
        aria-label="Accessory"
        @change="onSelect"
      >
        <option value="">Empty</option>
        <option v-for="option in options" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>

      <span class="font-mono text-[10px] text-neutral-700">$9400</span>
    </div>

    <div class="flex min-h-0 flex-1 items-center justify-center px-3 pb-2">
      <component :is="view" v-if="view && card" :card="card" />
      <p v-else class="text-xs tracking-[0.3em] text-neutral-700">EMPTY</p>
    </div>
  </section>
</template>

<style scoped>
.accessory-select {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #ccc;
  padding: 2px 6px;
  font-size: 11px;
  height: 22px;
  outline: none;
}
.accessory-select:focus {
  border-color: rgba(255, 255, 255, 0.35);
}
</style>
