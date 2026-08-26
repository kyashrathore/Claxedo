import type { OwnerInstrumentationEvent, OwnerInstrumentationSink } from "./owner-instrumentation"

export type RendererPhase = { name: string; durationMs: number }

declare global {
  interface Window {
    __claxedoPerfTrace?: boolean
    __claxedoPerfRendererPhases?: RendererPhase[]
    __claxedoPerfOwnerEvents?: OwnerInstrumentationEvent[]
    __CLAXEDO_OWNER_INSTRUMENTATION__?: OwnerInstrumentationSink
  }
}

export function rendererTraceEnabled() {
  return typeof window !== "undefined" && window.__claxedoPerfTrace === true
}

export function recordRendererPhase(name: string, durationMs = 0) {
  if (!rendererTraceEnabled()) return
  performance.mark(name)
  window.__claxedoPerfRendererPhases?.push({ name, durationMs })
}

export function measureRendererPhase<T>(name: string, task: () => T) {
  if (!rendererTraceEnabled()) return task()
  const started = performance.now()
  const result = task()
  window.__claxedoPerfRendererPhases?.push({ name, durationMs: performance.now() - started })
  return result
}
