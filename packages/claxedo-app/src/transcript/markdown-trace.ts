export function rendererClock(): number | undefined {
  if (typeof performance === "undefined") return undefined
  return performance.now()
}

interface PerfTraceWindow extends Window {
  __claxedoPerfTrace?: boolean
  __claxedoPerfRendererPhases?: Array<{ name: string; durationMs: number }>
}

export function traceRenderer(name: string, started?: number) {
  if (typeof window === "undefined") return
  const target: PerfTraceWindow = window
  if (!target.__claxedoPerfTrace) return
  target.__claxedoPerfRendererPhases?.push({
    name,
    durationMs: started === undefined ? 0 : performance.now() - started,
  })
}
