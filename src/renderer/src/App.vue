<script setup lang="ts">
/**
 * Scaffold for the KIMulator window.
 *
 * The grid is the layout the finished app uses — terminal top-left, LCD
 * top-right, keys beneath the LCD, accessory beneath the terminal, control bar
 * across the bottom. Each region is filled in by its own phase; until then it
 * names itself so `npm run dev` opens something that shows the shape of the
 * machine rather than a blank window.
 */
const regions = [
  { key: 'terminal', title: 'TERMINAL', note: '40 × 24, white on black', area: 'terminal' },
  { key: 'lcd', title: 'LCD', note: '16 × 2 HD44780', area: 'lcd' },
  { key: 'keys', title: 'KEYS', note: '24-key pad, 4 × 6', area: 'keys' },
  { key: 'accessory', title: 'ACCESSORY', note: 'the bus at $9400', area: 'accessory' }
]
</script>

<template>
  <div class="flex h-full flex-col bg-black text-white">
    <div class="kim-grid min-h-0 flex-1 gap-px bg-neutral-800 p-px">
      <section
        v-for="region in regions"
        :key="region.key"
        :style="{ gridArea: region.area }"
        class="flex flex-col items-center justify-center bg-black"
      >
        <h1 class="text-sm tracking-[0.3em] text-neutral-500">{{ region.title }}</h1>
        <p class="mt-1 text-xs text-neutral-700">{{ region.note }}</p>
      </section>
    </div>

    <footer
      class="flex h-10 shrink-0 items-center justify-center border-t border-neutral-800 bg-black text-xs tracking-[0.3em] text-neutral-700"
    >
      CONTROL BAR
    </footer>
  </div>
</template>

<style scoped>
.kim-grid {
  display: grid;
  grid-template-columns: 3fr 2fr;
  grid-template-rows: 3fr 2fr;
  grid-template-areas:
    'terminal lcd'
    'accessory keys';
}
</style>
