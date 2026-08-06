<script setup lang="ts">
/**
 * The KIM as a guest on someone else's page.
 *
 * Everything below the component layer is shared with the full app — the store,
 * the composables, the panels, the whole of `src/core`. What differs is what is
 * *absent*: no settings panel, no host serial port, no paste modal, no debug
 * bridge, and no file pickers. That is the reason this is a second entry point
 * rather than a flag on `App.vue`; the two component trees have almost nothing
 * in common above the panels, and shipping one as dead code inside the other
 * would make both harder to follow.
 *
 * The panels themselves are the same four, and `panels=` chooses which are
 * shown. Hiding one hides the *view*, never the hardware: the LCD is still being
 * driven behind `panels=terminal`, and the latch still lights lamps nobody can
 * see. A KIM is not assembled out of its panels.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { PlayIcon, CursorArrowRaysIcon } from '@heroicons/vue/24/solid'
import Terminal from '@/components/Terminal.vue'
import LCDPanel from '@/components/LCDPanel.vue'
import Keypad from '@/components/Keypad.vue'
import AccessoryPanel from '@/components/AccessoryPanel.vue'
import EmbedControlBar from '@/components/EmbedControlBar.vue'
import { useEmulatorStore } from '@/stores/emulator'
import { useConsole } from '@/composables/useConsole'
import { usePaste } from '@/composables/usePaste'
import { focus as focusRegion, useFocusRouter } from '@/composables/useFocusRouter'
import {
  loadDefaultROMs,
  DEFAULT_ROM_LABEL,
  DEFAULT_CARD_ROM_LABEL
} from '@/composables/useDefaultBIOS'
import { parseEmbedParams } from '@/embed/params'
import type { MediaSource, PanelName } from '@/embed/params'
import { tryLoadMedia } from '@/embed/media'
import { createKeyer } from '@/embed/keys'
import { useEmbedMessaging } from '@/embed/messaging'
import { createAccessory } from '@core/accessories/registry'

// Parsed before anything else: the machine's shape comes out of it, and
// `origins` has to be known before the first inbound message can arrive.
const params = parseEmbedParams(window.location.search)

const store = useEmulatorStore()
const term = useConsole()
const paste = usePaste()
const { focused: focusedRegion } = useFocusRouter()

const frameRef = ref<HTMLElement | null>(null)
const focused = ref(false)
const fullscreen = ref(false)
/** First interaction with the frame: what gives the machine the keyboard. */
const activated = ref(false)
const problems = ref<string[]>([...params.warnings])
const problemsOpen = ref(true)

const shown = computed<Record<PanelName, boolean>>(() => ({
  terminal: params.panels.includes('terminal'),
  lcd: params.panels.includes('lcd'),
  keys: params.panels.includes('keys'),
  accessory: params.panels.includes('accessory')
}))

/** The left column holds the terminal and the bay; the right, the glass and the pad. */
const leftColumn = computed(() => shown.value.terminal || shown.value.accessory)
const rightColumn = computed(() => shown.value.lcd || shown.value.keys)

/**
 * Which panel the first click hands the keyboard to.
 *
 * The pad, when it is on show, for the same reason the full app starts there:
 * the pad *is* the machine, and the splash is waiting for a key from it.
 */
const preferredRegion = computed<'keypad' | 'terminal'>(() =>
  shown.value.keys ? 'keypad' : 'terminal'
)

const hasKeyboardPanel = computed(() => shown.value.keys || shown.value.terminal)

/**
 * What the badge promises, which depends on what the click can actually deliver.
 * With neither input panel shown there is no keyboard to offer, so it says so.
 */
const badgeText = computed(() =>
  hasKeyboardPanel.value ? 'Click to use the keyboard' : 'Click to focus'
)

// Built during setup rather than in onMounted, because the postMessage layer
// subscribes to the Session's stop events and registers an onUnmounted hook —
// both of which have to happen while the component is still setting up.
store.init({
  serialCard: params.serialCard,
  accessory: createAccessory(params.accessory)
})

/** One hand on the pad, shared by the boot sequence and `6502-kim:key`. */
const keyer = createKeyer((code: number) => store.pressKey(code))

const messaging = useEmbedMessaging({
  origins: params.origins,
  keyer,
  whenReady,
  describe: () => ({
    rom: store.romName,
    cardROM: store.cardROMName,
    accessory: params.accessory,
    serialCard: params.serialCard,
    panels: params.panels,
    controls: params.controls,
    warnings: params.warnings
  })
})

// ── Boot ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Bounds the wait for the splash when the firmware never puts one up. */
const SPLASH_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 60_000
const POLL_MS = 100

/**
 * What the KC Monitor writes on the bottom line and means: nothing else runs
 * until a key arrives, from the pad or from the wire. This machine's equivalent
 * of the ACE embed's "wait for BASIC" — `autotype` and `keys=` both hold for it,
 * because a program keyed in over the splash goes nowhere.
 */
const SPLASH = 'ESC TO START'

let disposed = false

function note(problem: string): void {
  console.warn('[embed]', problem)
  problems.value = [...problems.value, problem]
}

async function bytesFor(source: MediaSource, what: string): Promise<Uint8Array | null> {
  const failures: string[] = []
  const bytes = await tryLoadMedia(source, what, failures)
  for (const failure of failures) note(failure)
  return bytes
}

onMounted(async () => {
  for (const warning of params.warnings) console.warn('[embed]', warning)

  // 1. Firmware. Both images, because a KIM boots from two — and the reset
  //    vector is in the second one, so a machine given only the BIOS has
  //    nothing to start from. The Keypad Card's ROM is always the bundled one:
  //    it is the machine's own firmware and there is no parameter for it.
  const defaults = await loadDefaultROMs()

  const rom = params.rom ? await bytesFor(params.rom, 'rom') : defaults.bios
  if (rom) store.loadROM(rom, params.rom?.label ?? DEFAULT_ROM_LABEL)
  else note('no BIOS loaded — the Kernal window will read as zeros')

  if (defaults.card) store.loadCardROM(defaults.card, DEFAULT_CARD_ROM_LABEL)
  else note('no Keypad Card ROM loaded — the machine has no firmware to reset into')

  // 2. Re-read the reset vector now the card's image is in, rather than the
  //    uninitialised address the CPU reset to when the machine was constructed.
  store.resetCPU()

  // 3. Binaries. After the reset, not before — a reset does not clear RAM, but a
  //    power cycle would, and keeping the order "firmware, reset, then RAM" is
  //    what makes that safe to change.
  for (const { address, source } of params.binaries) {
    const bytes = await bytesFor(source, 'bin')
    if (!bytes) continue
    store.loadBinary(bytes, address, source.label)
    if (store.loadWarning) note(store.loadWarning)
  }

  if (params.autostart) store.run()

  messaging.announceReady()

  if (params.autotype) void autotype(params.autotype)
  if (params.keys.length > 0) void autokey(params.keys)
})

let readyGate: Promise<boolean> | undefined

/**
 * The gate everything that *drives* the machine waits behind, started by
 * whichever of them asks first.
 *
 * Not just the boot sequence's `keys=` and `autotype=`: a `6502-kim:key` sent by
 * a host page the moment it hears `6502-kim:ready` waits here too. `ready` means
 * the firmware is in and the power is on, which is a good three seconds before
 * the machine can hear anything — and a host page should not have to know that,
 * nor time it. A press that arrives later, mid-session, finds this already
 * resolved and goes straight through.
 */
function whenReady(): Promise<boolean> {
  return (readyGate ??= waitForSplash())
}

/**
 * Wait for the machine to be somewhere that can take input.
 *
 * Two waits, both bounded. The first is for the machine to be running at all,
 * which under `autostart=0` means waiting for the reader to press Run — or for
 * a host page's `6502-kim:run`. The second is for the splash, which costs about
 * 1.8 M cycles to reach because `LcdInit` runs the HD44780's power-on ritual
 * with four ~41 ms software delays in it. Firmware that never puts a splash up
 * times out and is driven anyway, rather than silently doing nothing.
 *
 * @returns false if the frame went away, or the machine never ran at all.
 */
async function waitForSplash(): Promise<boolean> {
  const runDeadline = performance.now() + RUN_TIMEOUT_MS
  while (!disposed && !store.isRunning && performance.now() < runDeadline) await sleep(POLL_MS)
  if (disposed || !store.isRunning) return false

  const splashDeadline = performance.now() + SPLASH_TIMEOUT_MS
  while (!disposed && performance.now() < splashDeadline) {
    if (store.getLCD()?.getRowText(1).includes(SPLASH)) break
    await sleep(POLL_MS)
  }
  return !disposed
}

/**
 * Type at the machine down the serial line, once it can hear it.
 *
 * Bytes at the ACIA, exactly as if they had arrived from a real port — so this
 * takes anything the KC Monitor's serial monitor takes, `bin2woz` output
 * included. A frame built with `serialcard=0` has no ACIA at all and nothing
 * arrives, which is the hardware rather than a fault.
 */
async function autotype(text: string): Promise<void> {
  if (!(await whenReady())) return
  if (!store.machine?.acia()) {
    note('autotype: no Serial Card fitted — there is nowhere for the text to arrive')
    return
  }
  await paste.injectText(text)
}

/** Key a sequence on the pad, once the splash is up. */
async function autokey(codes: number[]): Promise<void> {
  if (!(await whenReady())) return
  await keyer.play(codes)
}

// ── Focus, activation and fullscreen ─────────────────────────────────────────

/**
 * `focusin`/`focusout` rather than `focus`/`blur` because they bubble: pressing
 * a control-bar button moves focus to the button, and the machine must not stop
 * listening to the keyboard because the reader pressed Reset. Focus only leaves
 * the embed when it lands somewhere outside the wrapper entirely.
 */
function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  focused.value = !!next && !!frameRef.value?.contains(next)
}

/**
 * A click into the frame.
 *
 * **Nothing takes the keyboard until this happens**, which is the whole
 * difference between the embed and the app. `App.vue` gives the pad the keyboard
 * as it mounts because the window is the machine; a frame that did that would be
 * a bad guest — an emulator halfway down an article that swallowed the reader's
 * page-down key because it happened to be on screen.
 *
 * So the first click is what hands a panel the keyboard, and under
 * `autostart=0` it is also what starts the machine, which is the promise the
 * overlay makes. Clicking a panel directly gets there by its own route (each one
 * takes the keyboard on mousedown) and lands on the panel the reader meant.
 */
function activate(): void {
  if (!focusedRegion.value && hasKeyboardPanel.value) focusRegion(preferredRegion.value)
  else if (!hasKeyboardPanel.value) frameRef.value?.focus({ preventScroll: true })

  if (activated.value) return
  activated.value = true
  if (!store.isRunning && !store.isHalted) store.run()
}

async function toggleFullscreen(): Promise<void> {
  const element = frameRef.value
  if (!element) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await element.requestFullscreen()
  } catch (e) {
    // Refused unless the host page's <iframe> carries allow="fullscreen".
    note(`fullscreen unavailable: ${(e as Error).message}`)
  }
}

function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement === frameRef.value
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))

onUnmounted(() => {
  disposed = true
  keyer.cancel()
  term.cancel()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})
</script>

<template>
  <div
    ref="frameRef"
    class="embed-frame"
    :class="{ 'is-focused': focused }"
    tabindex="0"
    @focusin="focused = true"
    @focusout="onFocusOut"
    @pointerdown="activate"
  >
    <!--
      The app's layout, minus whatever `panels=` left out. A column with nothing
      in it is not rendered at all, so `panels=lcd,keys` gives the glass and the
      pad the whole frame rather than two thirds of it beside an empty box.
    -->
    <div class="flex min-h-0 flex-1 gap-px bg-neutral-800">
      <div v-if="leftColumn" class="flex min-w-0 flex-3 flex-col gap-px">
        <Terminal v-if="shown.terminal" class="flex-4" />
        <AccessoryPanel v-if="shown.accessory" class="flex-1" fixed />
      </div>

      <div v-if="rightColumn" class="flex min-w-0 flex-2 flex-col gap-px">
        <LCDPanel v-if="shown.lcd" class="flex-2" />
        <Keypad v-if="shown.keys" class="flex-3" />
      </div>
    </div>

    <EmbedControlBar
      v-if="params.controls !== 'none'"
      :mode="params.controls"
      :fullscreen="fullscreen"
      @toggle-fullscreen="toggleFullscreen"
    />

    <!--
      Two shapes, because the prompt has two different jobs.

      Under `autostart=0` the machine is off and clicking really is what starts
      it, so the prompt covers the frame and says so.

      Under `autostart=1` the machine is already booting, and "Click to start"
      would be describing something that has already happened, over the top of
      the one thing that proves the embed works. All that is left to ask for is
      the keyboard, so the prompt shrinks to a corner badge and says that
      instead. It loses nothing by being small: the whole frame is the click
      target either way.
    -->
    <div v-if="!activated && !params.autostart" class="embed-overlay" @click="activate">
      <div class="embed-prompt">
        <PlayIcon class="size-8" />
        <span>Click to start</span>
      </div>
    </div>
    <div v-else-if="!activated" class="embed-prompt embed-badge" @click="activate">
      <CursorArrowRaysIcon class="size-4" />
      <span>{{ badgeText }}</span>
    </div>

    <div v-if="problems.length && problemsOpen" class="embed-problems">
      <button class="embed-problems-close" title="Dismiss" @click.stop="problemsOpen = false">
        &times;
      </button>
      <p v-for="(problem, i) in problems" :key="i">{{ problem }}</p>
    </div>
  </div>
</template>

<style scoped>
.embed-frame {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  position: relative;
  outline: none;
  background: #171717; /* neutral-900, the app's own ground */
  color: #fff;
}

/*
  A visible focus ring is not decoration here: the embed only receives keys
  while it has focus, so "is this thing listening to me?" needs an answer on
  screen. This one is about the *frame*; which panel holds the keyboard is said
  again, and more precisely, by the keyboard badge in each panel's corner.
*/
.embed-frame.is-focused::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 0 2px rgb(255 255 255 / 0.35);
}

.embed-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(0 0 0 / 0.55);
  cursor: pointer;
}

.embed-prompt {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid rgb(255 255 255 / 0.3);
  background: rgb(0 0 0 / 0.6);
  font: 500 0.95rem/1.2 system-ui, sans-serif;
  color: #fff;
}

/*
  The same prompt, out of the way. Pinned to the top-left over a running machine
  rather than centred over a dimmed one — top-*left* because the LCD and the pad
  sit on the right and each carries a focus badge in its own corner, which this
  would otherwise land on.
*/
.embed-badge {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  padding: 0.3rem 0.6rem;
  border-radius: 999px;
  font-size: 0.75rem;
  cursor: pointer;
}

/*
 * Advisory, not alarming. Nothing that reaches this banner is fatal — a
 * malformed parameter has already fallen back to its default and a file that
 * would not load has left a working KC Monitor behind it — so it is styled as a
 * note over the picture rather than as an error.
 */
.embed-problems {
  position: absolute;
  left: 0.5rem;
  right: 0.5rem;
  bottom: 0.5rem;
  padding: 0.5rem 1.75rem 0.5rem 0.6rem;
  border-radius: 0.375rem;
  border: 1px solid rgb(255 255 255 / 0.25);
  background: rgb(20 20 20 / 0.88);
  font: 400 0.75rem/1.35 ui-monospace, monospace;
  color: rgb(255 255 255 / 0.82);
  max-height: 40%;
  overflow-y: auto;
}

.embed-problems-close {
  position: absolute;
  top: 0.15rem;
  right: 0.4rem;
  font-size: 1rem;
  line-height: 1;
  color: inherit;
  cursor: pointer;
}
</style>
