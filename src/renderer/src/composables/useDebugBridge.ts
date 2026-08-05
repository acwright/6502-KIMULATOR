import { onUnmounted, watch } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { bootPayload } from '@/composables/useBoot'
import { useConsole } from '@/composables/useConsole'
import { RendererTarget } from '@/debug/RendererTarget'
import { createMethods } from '@debug/server/Methods'
import { ErrorCode, RpcMethodError } from '@debug/server/Protocol'
import { formatForPath, parseSymbols } from '@debug/symbols/parse'

/**
 * Wires the desktop app's own machine into the debug protocol (§4.3).
 *
 * Registers the renderer as main's method dispatcher and forwards this
 * machine's stop/resume events to it, regardless of whether the debug server
 * is currently switched on — main simply has nothing to forward the events to
 * until a client is listening, so there is no "turn this on too" step to
 * coordinate with the Settings toggle.
 *
 * A no-op outside Electron: `window.api` does not exist in the web build.
 *
 * Call this at the top level of a component's `<script setup>`, the same way
 * as `useKeyboard()` — it registers `onUnmounted`, which Vue only accepts
 * during a component's synchronous setup, not from inside an async
 * `onMounted` callback after that component has already awaited something.
 * `store.session` is still null at that point (App.vue's own onMounted hasn't
 * run store.init() yet), so the actual wiring waits for it via `watch`
 * instead of requiring it up front.
 *
 * The watch stays armed rather than firing once. A card cannot be fitted or
 * pulled with the power on, so toggling the Serial Card builds a *new* machine
 * and a new Session — and a bridge still holding the old one would answer a
 * debug client about a machine that is no longer on the bench.
 */
export function useDebugBridge(): void {
  if (!window.api) return
  const api = window.api

  const store = useEmulatorStore()
  // The same buffer the Terminal panel draws — `serial.read` and the window are
  // answering from one place, so they cannot disagree about what was said.
  const serialConsole = useConsole()

  // Populated once store.session becomes available, and replaced wholesale
  // whenever it changes. Collected in one place so the single onUnmounted below
  // — registered synchronously, before this function returns — can always find
  // them, regardless of how much async work has happened by then.
  let unmounted = false
  let cleanups: (() => void)[] = []

  const release = (): void => {
    for (const cleanup of cleanups) cleanup()
    cleanups = []
  }

  // Bumped on every session change. A run of this callback that is no longer
  // the current one has to abandon its work at the next await rather than
  // register listeners against a machine that has already been replaced.
  let generation = 0

  const stopWatch = watch(
    () => store.session,
    async (session) => {
      release()
      const mine = ++generation
      const stale = (): boolean => unmounted || generation !== mine
      if (!session) return

      const target = new RendererTarget(session, await api.app.getVersion(), serialConsole)
      // The component may have been torn down while that await was pending.
      if (stale()) return

      // `6502-kim run --symbols`: the same table `sym.load` would build, in place
      // before a client has had a chance to ask for it.
      const boot = await bootPayload()
      if (boot?.symbols && !stale()) {
        try {
          const { path, text } = boot.symbols
          target.symbols.merge(parseSymbols(text, formatForPath(path), path))
          // Conditions like `PC == main` resolve through the session.
          session.symbolResolver = (name) => target.symbols.resolve(name)
        } catch (e) {
          console.error('[boot] symbols:', e)
        }
      }
      if (stale()) return

      const methods = createMethods(target)

      const offCall = api.debug.onCall(async (method, params) => {
        const handler = methods[method]
        if (!handler) {
          return { error: { code: ErrorCode.METHOD_NOT_FOUND, message: `no such method "${method}"` } }
        }
        try {
          return { result: await handler(params) }
        } catch (e) {
          if (e instanceof RpcMethodError) {
            return { error: { code: e.code, message: e.message, data: e.data } }
          }
          const message = e instanceof Error ? e.message : String(e)
          return { error: { code: ErrorCode.INTERNAL_ERROR, message: `${method}: ${message}` } }
        }
      })

      const offStop = session.onStop((reason) => api.debug.emitEvent('stopped', { stop: reason }))
      const offResume = session.onResume((mode) => api.debug.emitEvent('resumed', { mode }))

      cleanups.push(offCall, offStop, offResume)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    unmounted = true
    stopWatch()
    release()
  })
}
