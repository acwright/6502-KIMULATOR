<script setup lang="ts">
/**
 * Everything about the machine that is not a button on the control bar.
 *
 * Ported from 6502-EMULATOR with the KIM's sections. STORAGE and JOYSTICK are
 * gone with the hardware they configured. MACHINE and ACCESSORY are new, and
 * both change the machine's *shape* — which is why they rebuild it rather than
 * poking the one on the bench. You cannot fit a card with the power on.
 *
 * The Keypad Card ROM lives here rather than on the toolbar, and is labelled for
 * what it is. It is how a freshly built `KC Monitor.bin` gets tried without
 * burning an AT28C64 — but it is changing the machine's own firmware, not
 * slotting in a cartridge, and it should sit where you have to mean it.
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { ArrowPathIcon, XMarkIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/vue/24/solid'
import { useEmulatorStore } from '@/stores/emulator'
import { useMachine } from '@/composables/useMachine'
import { useAccessory } from '@/composables/useAccessory'
import { useSerial } from '@/composables/useSerial'
import {
  loadDefaultBIOS,
  loadDefaultCardROM,
  DEFAULT_ROM_LABEL,
  DEFAULT_CARD_ROM_LABEL
} from '@/composables/useDefaultBIOS'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'
import type { SerialConfig, PortInfo, DebugServerStatus, CliShimStatus } from '@shared/types'

defineEmits<{ close: [] }>()

const store = useEmulatorStore()
const machine = useMachine()
const { status: serialStatus, connect, disconnect } = useSerial()
const isElectron = computed(() => typeof window !== 'undefined' && !!window.api)

// ── Files ─────────────────────────────────────────────────────────────────────

const romInput = ref<HTMLInputElement | null>(null)
const cardROMInput = ref<HTMLInputElement | null>(null)

async function readInputFile(event: Event): Promise<{ data: Uint8Array; name: string } | null> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return null
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  return { data, name: file.name }
}

async function onLoadROM(event: Event): Promise<void> {
  const f = await readInputFile(event)
  if (f) machine.setROM(f.data, f.name)
}

async function onLoadCardROM(event: Event): Promise<void> {
  const f = await readInputFile(event)
  if (f) machine.setCardROM(f.data, f.name)
}

async function resetROM(): Promise<void> {
  const bios = await loadDefaultBIOS()
  if (bios) machine.setROM(bios, DEFAULT_ROM_LABEL)
}

async function resetCardROM(): Promise<void> {
  const card = await loadDefaultCardROM()
  if (card) machine.setCardROM(card, DEFAULT_CARD_ROM_LABEL)
}

// ── Raw binary at an explicit address ─────────────────────────────────────────

const binaryInput = ref<HTMLInputElement | null>(null)
/** $0800 is where the monitor puts you and where user programs live — 6502.inc. */
const binaryAddress = ref('0800')

/** Parsed hex load address, or null while the field is empty or out of RAM. */
const binaryLoadAddress = computed(() => {
  const text = binaryAddress.value.trim().replace(/^(\$|0x)/i, '')
  if (!/^[0-9a-f]{1,4}$/i.test(text)) return null
  const address = parseInt(text, 16)
  return address < 0x8000 ? address : null
})

async function onLoadBinary(event: Event): Promise<void> {
  const address = binaryLoadAddress.value
  const f = await readInputFile(event)
  if (f && address !== null) store.loadBinary(f.data, address, f.name)
}

// ── Machine ───────────────────────────────────────────────────────────────────

/**
 * The Serial Card is not decoration: `KC Monitor.asm` guards every ACIA access
 * on `HW_PRESENT & HW_SC`, so removing it is the only way to exercise the
 * keypad-only path the firmware explicitly supports.
 */
function toggleSerialCard(event: Event): void {
  const installed = (event.target as HTMLInputElement).checked
  machine.rebuild({ serialCard: installed })
  window.api?.settings.set({ serialCardFitted: installed }).catch(() => {})
}

// ── Accessory ─────────────────────────────────────────────────────────────────

/**
 * The same choice the bay in the window offers, through the same composable —
 * two dropdowns that could disagree about what is on the bus would be worse
 * than either on its own.
 */
const {
  options: accessories,
  fitted: fittedAccessory,
  selected: selectedAccessory,
  fit: fitAccessory
} = useAccessory()

function onSelectAccessory(event: Event): void {
  fitAccessory((event.target as HTMLSelectElement).value || null)
}

// ── Serial ────────────────────────────────────────────────────────────────────

const ports = ref<PortInfo[]>([])
const selectedPort = ref('')
const serialConfig = ref<SerialConfig>({ ...DEFAULT_SERIAL_CONFIG })

async function refreshPorts(): Promise<void> {
  if (!isElectron.value) return
  try {
    ports.value = await window.api!.serial.listPorts()
  } catch {
    /* ignore */
  }
}

async function toggleSerial(): Promise<void> {
  if (serialStatus.value === 'connected') {
    await disconnect()
  } else {
    await connect(serialConfig.value, isElectron.value ? selectedPort.value || undefined : undefined)
  }
}

// Only a change the user made here is worth saving. Loading the current settings
// into the fields below counts as a change to this watcher, and writing that
// straight back would persist whatever happened to be in effect — including
// settings `6502-kim run` set for one launch only.
let hydrating = true

watch(
  serialConfig,
  (cfg) => {
    if (hydrating) return
    window.api?.settings.set({ serialConfig: { ...cfg } }).catch(() => {})
  },
  { deep: true }
)

// ── Debug server ──────────────────────────────────────────────────────────────

const debugStatus = ref<DebugServerStatus>({ running: false })
const copiedUrl = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Everything a client needs in one string. The token rides in the query the
 * same way `6502-kim attach` puts it there, so the pasted URL authenticates by
 * itself rather than leaving the token to be found separately.
 */
const debugConnectionUrl = computed(() => {
  const status = debugStatus.value
  if (!status.url) return ''
  return status.token ? `${status.url}/?token=${status.token}` : status.url
})

async function toggleDebugServer(): Promise<void> {
  if (debugStatus.value.running) await window.api!.debug.stop()
  else debugStatus.value = await window.api!.debug.start()
}

async function copyDebugUrl(): Promise<void> {
  if (!debugConnectionUrl.value) return
  await navigator.clipboard.writeText(debugConnectionUrl.value)
  // Writing to the clipboard is silent; without this the button reads as dead
  // even when it worked.
  copiedUrl.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedUrl.value = false
  }, 1500)
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

const cliStatus = ref<CliShimStatus>({ installed: false })
const cliMessage = ref('')

async function toggleCli(): Promise<void> {
  cliMessage.value = ''
  const result = cliStatus.value.installed
    ? await window.api!.cli.uninstall()
    : await window.api!.cli.install()
  cliMessage.value = result.message
  cliStatus.value = await window.api!.cli.status()
}

// ── Initialisation ────────────────────────────────────────────────────────────

let offDebugStatus: (() => void) | undefined

onMounted(async () => {
  if (!isElectron.value) return
  try {
    const settings = await window.api!.settings.get()
    serialConfig.value = { ...DEFAULT_SERIAL_CONFIG, ...settings.serialConfig }
    // Let the assignment above reach the watcher before edits start counting.
    await nextTick()
  } catch {
    /* use defaults */
  }
  hydrating = false
  await refreshPorts()

  debugStatus.value = await window.api!.debug.status()
  offDebugStatus = window.api!.debug.onStatusChanged((status) => {
    debugStatus.value = status
  })
  cliStatus.value = await window.api!.cli.status()
})

onUnmounted(() => {
  offDebugStatus?.()
  clearTimeout(copiedTimer)
})
</script>

<template>
  <!-- Semi-transparent backdrop — clicking closes the panel -->
  <div class="settings-backdrop" @click="$emit('close')" />

  <!-- Right-side slide-in panel -->
  <div class="settings-panel">
    <div class="panel-header">
      <span class="panel-title">Settings</span>
      <button class="close-btn" title="Close" @click="$emit('close')">✕</button>
    </div>

    <div class="panel-body">
      <!-- ── Files ─────────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">FILES</h3>

        <div class="file-row">
          <span class="file-kind">BIOS</span>
          <span class="file-name" :title="store.romName">{{ store.romName }}</span>
          <input ref="romInput" type="file" accept=".bin,.rom" class="hidden" @change="onLoadROM" />
          <button class="btn-sm btn-secondary" @click="romInput?.click()">Load</button>
          <button
            v-if="store.romName !== DEFAULT_ROM_LABEL"
            class="btn-icon"
            title="Reset to the bundled BIOS"
            @click="resetROM"
          >
            <XMarkIcon class="size-4" />
          </button>
        </div>

        <div class="file-row">
          <span class="file-kind">CARD</span>
          <span class="file-name" :title="store.cardROMName">{{ store.cardROMName }}</span>
          <input
            ref="cardROMInput"
            type="file"
            accept=".bin,.rom"
            class="hidden"
            @change="onLoadCardROM"
          />
          <button class="btn-sm btn-secondary" @click="cardROMInput?.click()">Load</button>
          <button
            v-if="store.cardROMName !== DEFAULT_CARD_ROM_LABEL"
            class="btn-icon"
            title="Reset to the bundled KC Monitor"
            @click="resetCardROM"
          >
            <XMarkIcon class="size-4" />
          </button>
        </div>

        <p class="hint">
          <strong>Keypad Card ROM</strong> — the 8 KB AT28C64 image, and where the
          reset vector lives. Loading one replaces the machine's own firmware.
        </p>

        <!-- Bytes at an address — the type-in cards without the typing. -->
        <div class="file-row">
          <span class="file-kind">BIN</span>
          <span class="file-name" :title="store.binaryName ?? ''">{{ store.binaryName ?? '—' }}</span>
          <input
            v-model="binaryAddress"
            class="field addr-field"
            spellcheck="false"
            placeholder="addr"
            title="Load address in hex, e.g. 0800"
          />
          <input ref="binaryInput" type="file" accept=".bin" class="hidden" @change="onLoadBinary" />
          <button
            class="btn-sm btn-secondary"
            :disabled="binaryLoadAddress === null"
            @click="binaryInput?.click()"
          >
            Load
          </button>
        </div>

        <p v-if="store.loadWarning" class="load-warning">{{ store.loadWarning }}</p>
      </section>

      <!-- ── Machine ───────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">MACHINE</h3>

        <label class="toggle-row">
          <input
            type="checkbox"
            :checked="store.serialCardFitted"
            @change="toggleSerialCard"
          />
          <span>Serial Card installed (io5, <code>$9000</code>)</span>
        </label>

        <p class="hint">
          Remove it and the machine runs from the keypad and LCD alone — the KC
          Monitor is built for that, so nothing breaks; there is simply no serial
          port. Adding or removing a card switches the machine off and on, so RAM
          is cleared.
        </p>
      </section>

      <!-- ── Accessory ─────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">ACCESSORY</h3>

        <div class="config-item">
          <label class="config-label">Wired to <code>$9400</code> (io6)</label>
          <select class="field" :value="selectedAccessory" @change="onSelectAccessory">
            <option value="">Empty</option>
            <option v-for="option in accessories" :key="option.id" :value="option.id">
              {{ option.name }}
            </option>
          </select>
        </div>

        <p class="hint">
          {{
            fittedAccessory?.description ??
            'Where a breadboard circuit plugs into the bus. An empty bay is how a KIM sits with nothing attached to it.'
          }}
          Wiring something in switches the machine off and on, so RAM is cleared.
        </p>
      </section>

      <!-- ── Serial ────────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">SERIAL</h3>

        <div class="serial-status-row">
          <span
            class="status-dot"
            :class="{
              'bg-gray-500': serialStatus === 'disconnected',
              'bg-yellow-400 animate-pulse': serialStatus === 'connecting',
              'bg-green-500': serialStatus === 'connected',
              'bg-red-500': serialStatus === 'error'
            }"
          />
          <span class="status-text">{{ serialStatus }}</span>
        </div>

        <p v-if="!store.serialCardFitted" class="load-warning">
          No Serial Card installed — there is no serial port to connect to.
        </p>

        <!-- Electron: port selector + config -->
        <template v-if="isElectron">
          <div class="port-row">
            <select v-model="selectedPort" class="field port-select">
              <option value="">— select port —</option>
              <option v-for="p in ports" :key="p.path" :value="p.path">
                {{ p.path }}{{ p.manufacturer ? ` (${p.manufacturer})` : '' }}
              </option>
            </select>
            <button class="btn-icon" title="Refresh ports" @click="refreshPorts">
              <ArrowPathIcon class="size-4" />
            </button>
          </div>

          <div class="config-grid">
            <div class="config-item">
              <label class="config-label">Baud Rate</label>
              <input v-model.number="serialConfig.baudRate" type="number" class="field" />
            </div>
            <div class="config-item">
              <label class="config-label">Data Bits</label>
              <select v-model.number="serialConfig.dataBits" class="field">
                <option :value="8">8</option>
                <option :value="7">7</option>
                <option :value="6">6</option>
                <option :value="5">5</option>
              </select>
            </div>
            <div class="config-item">
              <label class="config-label">Parity</label>
              <select v-model="serialConfig.parity" class="field">
                <option value="none">None</option>
                <option value="even">Even</option>
                <option value="odd">Odd</option>
              </select>
            </div>
            <div class="config-item">
              <label class="config-label">Stop Bits</label>
              <select v-model.number="serialConfig.stopBits" class="field">
                <option :value="1">1</option>
                <option :value="2">2</option>
              </select>
            </div>
          </div>
        </template>

        <button
          class="btn-connect"
          :class="serialStatus === 'connected' ? 'btn-danger' : 'btn-primary'"
          :disabled="serialStatus === 'connecting' || !store.serialCardFitted"
          @click="toggleSerial"
        >
          {{ serialStatus === 'connected' ? 'Disconnect' : 'Connect' }}
        </button>
      </section>

      <!-- ── Debug ─────────────────────────────────────────────────────────── -->
      <section v-if="isElectron" class="panel-section">
        <h3 class="section-heading">DEBUG SERVER</h3>

        <div class="serial-status-row">
          <span class="status-dot" :class="debugStatus.running ? 'bg-green-500' : 'bg-gray-500'" />
          <span class="status-text">
            {{ debugStatus.running ? `listening on ${debugStatus.host}:${debugStatus.port}` : 'off' }}
          </span>
        </div>

        <!-- The value shrinks and the button never does, so the button stays
             inside the 320 px panel however long the URL and token get. -->
        <div v-if="debugStatus.running" class="debug-url">
          <span class="debug-url-value" :title="debugConnectionUrl">{{ debugConnectionUrl }}</span>
          <button
            class="btn-icon copy-btn"
            :title="copiedUrl ? 'Copied' : 'Copy connection URL'"
            @click="copyDebugUrl"
          >
            <CheckIcon v-if="copiedUrl" class="size-4 copied" />
            <ClipboardDocumentIcon v-else class="size-4" />
          </button>
        </div>

        <p class="hint">
          Lets <code>6502-kim dbg</code> and <code>6502-kim attach</code> connect
          to this running machine. Both find it on their own while it is running
          here; the URL above is for anything else that speaks the protocol.
        </p>

        <button
          class="btn-connect"
          :class="debugStatus.running ? 'btn-danger' : 'btn-primary'"
          @click="toggleDebugServer"
        >
          {{ debugStatus.running ? 'Stop' : 'Start' }}
        </button>
      </section>

      <!-- ── CLI ───────────────────────────────────────────────────────────── -->
      <section v-if="isElectron" class="panel-section">
        <h3 class="section-heading">COMMAND LINE</h3>

        <p class="hint">
          {{
            cliStatus.managedByInstaller
              ? "Installed by this platform's installer."
              : cliStatus.installed
                ? `Installed at ${cliStatus.path}`
                : "Adds the '6502-kim' command to your PATH."
          }}
        </p>

        <p v-if="cliMessage" class="hint">{{ cliMessage }}</p>

        <button
          v-if="!cliStatus.managedByInstaller"
          class="btn-connect"
          :class="cliStatus.installed ? 'btn-danger' : 'btn-primary'"
          @click="toggleCli"
        >
          {{ cliStatus.installed ? 'Uninstall' : 'Install' }}
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ── Backdrop ────────────────────────────────────────────────────────────────── */
.settings-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 99;
}

/* ── Panel ───────────────────────────────────────────────────────────────────── */
.settings-panel {
  position: fixed;
  top: 0;
  right: 0;
  /* `dvh`, not `100%`: a fixed element sized against the layout viewport runs on
     under mobile Safari's toolbars, which is what put the bottom of this panel
     out of reach. The dynamic viewport is the part actually on the screen. */
  height: 100dvh;
  width: 320px;
  background: #141414;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
  /* Outside #app, so its safe-area padding does not apply here. */
  padding-top: env(safe-area-inset-top);
  padding-right: env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
}

/*
  On a phone a 320px drawer leaves a strip of the machine showing down one side
  that is too narrow to read and too wide to ignore, and it steals the width the
  settings rows themselves want. Below that, the panel is the screen.
*/
@media (max-width: 560px) {
  .settings-panel {
    width: 100%;
    border-left: none;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #fff;
}

.close-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 14px;
  color: #999;
  transition: color 0.15s, background 0.15s;
}
.close-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

/* ── Sections ────────────────────────────────────────────────────────────────── */
.panel-section {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.section-heading {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #555;
  margin: 0 0 10px 0;
}

/* ── File rows ───────────────────────────────────────────────────────────────── */
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-width: 0;
}

.file-kind {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: #666;
  width: 36px;
  flex-shrink: 0;
}

.file-name {
  flex: 1;
  font-size: 12px;
  font-family: monospace;
  color: #bbb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.addr-field {
  width: 56px;
  flex-shrink: 0;
  text-align: center;
}

.load-warning {
  font-size: 11px;
  line-height: 1.4;
  color: #d9a441;
  margin: 2px 0 8px 0;
}

/* ── Toggles ─────────────────────────────────────────────────────────────────── */
.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #ccc;
  cursor: pointer;
  margin: 4px 0 8px 0;
}
.toggle-row input { cursor: pointer; }
.toggle-row code { font-family: monospace; color: #999; }

/* ── Serial ──────────────────────────────────────────────────────────────────── */
.serial-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-text {
  font-size: 12px;
  color: #888;
  font-family: monospace;
}

.port-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  margin-bottom: 10px;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.config-item .field {
  width: 100%;
}

/* ── Debug / hints ───────────────────────────────────────────────────────────── */
.debug-url {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 10px 0;
}

/* min-width: 0 is what lets the URL shrink. A flex item defaults to
   min-width: auto, so without it the 64-character token pushes the copy button
   out past the panel's edge — which is exactly how it was unreachable. */
.debug-url-value {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: monospace;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn { flex-shrink: 0; }
.copied { color: #4ade80; }

.hint {
  font-size: 11px;
  line-height: 1.4;
  color: #666;
  /* A top margin as well as a bottom one: a hint explains the control above it,
     and with none it sat flush against the accessory dropdown's border and read
     as part of the field rather than as a note about it. */
  margin: 6px 0 10px 0;
}
.hint code { font-family: monospace; color: #999; }
.hint strong { color: #999; font-weight: 600; }

/* ── Fields ──────────────────────────────────────────────────────────────────── */
.field {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #eee;
  /* Padding, not a fixed height. A field pinned to 26px has nowhere to put the
     16px text a touch device raises it to, and the glyphs spill out of the box —
     which is what the accessory dropdown was doing on an iPad. Sized by its own
     line instead, it comes out the same on a desktop and simply grows when the
     text does. */
  padding: 3px 6px;
  font-size: 12px;
  font-family: monospace;
  line-height: 1.5;
  outline: none;
}
.field:focus { border-color: rgba(255, 255, 255, 0.35); }
.field:disabled { opacity: 0.5; }

.port-select { flex: 1; }

.config-label {
  font-size: 10px;
  color: #666;
  letter-spacing: 0.03em;
}
.config-label code { font-family: monospace; color: #888; }

/* ── Buttons ─────────────────────────────────────────────────────────────────── */
.btn-icon {
  display: flex;
  align-items: center;
  padding: 3px;
  border-radius: 4px;
  color: #888;
}
.btn-icon:hover { color: #fff; }

.btn-sm {
  padding: 3px 9px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  height: 24px;
  white-space: nowrap;
}

.btn-connect {
  width: 100%;
  padding: 6px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.btn-connect:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary  { background: rgba(99, 102, 241, 0.85); color: #fff; }
.btn-primary:hover:not(:disabled)  { background: rgba(99, 102, 241, 1); }

.btn-danger   { background: rgba(239, 68, 68, 0.75);  color: #fff; }
.btn-danger:hover:not(:disabled)   { background: rgba(239, 68, 68, 0.9); }

.btn-secondary {
  background: rgba(255, 255, 255, 0.07);
  color: #ccc;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.btn-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
</style>
