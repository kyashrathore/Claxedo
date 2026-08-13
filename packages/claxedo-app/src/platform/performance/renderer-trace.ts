/**
 * Renderer-phase tracing, consumed by the perf harness.
 *
 * When the harness sets `window.__claxedoPerfTrace = true`, each measured
 * phase pushes `{ name, durationMs }` onto `window.__claxedoPerfRendererPhases`
 * (an array the harness pre-creates and reads wholesale). Outside the harness
 * the wrapper is a plain call with no timing reads.
 */

declare global {
  interface Window {
    /** Set by the perf harness before load; absent in production. */
    __claxedoPerfTrace?: boolean
    /** Pre-created by the perf harness; read wholesale after the run. */
    __claxedoPerfRendererPhases?: Array<{ name: string; durationMs: number }>
  }
}

/** True when the perf harness armed tracing for this window. */
export function rendererTraceEnabled(): boolean {
  return typeof window !== "undefined" && window.__claxedoPerfTrace === true
}

/**
 * Record a named phase mark, and push it onto the harness's phase list with
 * the given duration (module-evaluation marks record 0 — the INSTANT matters,
 * not a span). No-op outside the harness.
 */
export function markRendererPhase(name: string, durationMs = 0): void {
  if (!rendererTraceEnabled()) return
  performance.mark(name)
  window.__claxedoPerfRendererPhases?.push({ name, durationMs })
}

export function measureRendererPhase<T>(name: string, task: () => T): T {
  if (typeof window === "undefined" || window.__claxedoPerfTrace !== true) return task()
  const started = performance.now()
  const result = task()
  const phases = window.__claxedoPerfRendererPhases
  if (Array.isArray(phases)) phases.push({ name, durationMs: performance.now() - started })
  return result
}
