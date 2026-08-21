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

/**
 * `fixed` names the bay rather than offering it — what the embed wants.
 *
 * A frame's machine is described by its URL, and changing the circuit rebuilds
 * the machine: a reader who opened the dropdown out of curiosity would clear the
 * RAM the page had just written its example program into, with nothing on screen
 * to explain where it went.
 */
const props = withDefaults(defineProps<{ fixed?: boolean }>(), { fixed: false })

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
    <!-- The circuit first and the selector under it, centred.

         The bay is a panel about what is plugged in, so what is plugged in gets
         the panel; the dropdown is how you change it, which is a thing you do
         once and then stop looking at. Along the bottom it reads as the bay's
         own control rather than as a heading the circuit belongs to. -->
    <div class="flex min-h-0 flex-1 items-center justify-center px-3 pt-3 pb-2">
      <component :is="view" v-if="view && card" :card="card" />
      <p v-else class="text-xs tracking-[0.3em] text-neutral-700">EMPTY</p>
    </div>

    <!-- No heading anywhere. None of the other panels carry one, and this
         already says what the panel is. -->
    <div class="flex shrink-0 items-center justify-center gap-3 px-3 pb-3">
      <!-- The address labels the list rather than sitting beside it. It says
           which bus these circuits go on, which is something you want while you
           are choosing one and clutter the rest of the time — and a panel whose
           only two pieces of chrome were a dropdown and a number floating to its
           right read as two controls rather than one. -->
      <select
        v-if="!props.fixed"
        class="accessory-select"
        :value="selected"
        title="What is wired to the bus at $9400. Changing it switches the machine off and on."
        aria-label="Accessory"
        @change="onSelect"
      >
        <optgroup label="Bus $9400">
          <option value="">Empty</option>
          <option v-for="option in options" :key="option.id" :value="option.id">
            {{ option.name }}
          </option>
        </optgroup>
      </select>

      <!-- The embed has no dropdown to open, so the address stays on the panel. -->
      <template v-else>
        <span class="text-[11px] text-neutral-400" aria-label="Accessory">
          {{ fitted?.name ?? 'Empty' }}
        </span>
        <span class="font-mono text-[10px] text-neutral-700">$9400</span>
      </template>
    </div>
  </section>
</template>

<style scoped>
.accessory-select {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #ccc;
  /* Padding, not a fixed height — see `.field` in SettingsPanel. Pinned to
     22px, the 16px text a touch device raises this to had nowhere to go and
     stood taller than the control drawn around it. */
  padding: 3px 6px;
  font-size: 11px;
  line-height: 1.5;
  outline: none;
}
.accessory-select:focus {
  border-color: rgba(255, 255, 255, 0.35);
}
</style>
