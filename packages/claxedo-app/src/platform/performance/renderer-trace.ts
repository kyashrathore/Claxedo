/**
 * Renderer-phase tracing, consumed by the perf harness.
 *
 * When the harness sets `window.__claxedoPerfTrace = true`, each measured
 * phase pushes `{ name, durationMs }` onto `window.__claxedoPerfRendererPhases`
 * (an array the harness pre-creates and reads wholesale). Outside the harness
 * the wrapper is a plain call with no timing reads.
 */
export function measureRendererPhase<T>(name: string, task: () => T): T {
  if (
    typeof window === "undefined" ||
    (window as unknown as Record<string, unknown>).__claxedoPerfTrace !== true
  ) return task()
  const started = performance.now()
  const result = task()
  const phases = (window as unknown as Record<string, unknown>).__claxedoPerfRendererPhases
  if (Array.isArray(phases)) phases.push({ name, durationMs: performance.now() - started })
  return result
}
