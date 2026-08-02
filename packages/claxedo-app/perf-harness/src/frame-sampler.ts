import type { Page } from "playwright"

// Physical frame budgets. These are absolute targets, not tunable knobs:
// a frame must be produced inside these windows or the refresh rate drops.
export const FRAME_120HZ_MS = 1000 / 120 // 8.333ms — the 120hz goal
export const FRAME_60HZ_MS = 1000 / 60 // 16.667ms — the hard floor

// How many individual frames are allowed to exceed the 60hz floor before a
// flow is considered to have actually stuttered. Every real interaction pays
// one or two heavy layout/paint frames on the initial state change; sustained
// jank is what we fail on, not the unavoidable first frame.
export const FRAMES_OVER_60HZ_ALLOWANCE = 2

export type FrameVerdict = "green" | "amber" | "red"

// One measured interaction. `worstFrameMs`/`p95FrameMs` are the headline:
// "in most cases 120hz" maps to p95 <= 8.33, "nowhere below 60hz" maps to the
// worst frame and the over-60hz count.
export type FrameMetric = {
  label: string
  worstFrameMs: number
  p95FrameMs: number
  framesOver833: number
  framesOver1667: number
  sampleCount: number
  completionMs: number
  verdict: FrameVerdict
}

export function frameVerdict(p95FrameMs: number): FrameVerdict {
  if (p95FrameMs <= FRAME_120HZ_MS + 0.5) return "green"
  if (p95FrameMs <= FRAME_60HZ_MS + 0.5) return "amber"
  return "red"
}

// The badge reflects the full picture: sustained rate (p95) AND whether more than
// the allowed number of individual frames dropped below 60hz.
function verdictFor(p95FrameMs: number, framesOver1667: number): FrameVerdict {
  if (p95FrameMs > FRAME_60HZ_MS + 0.5 || framesOver1667 > FRAMES_OVER_60HZ_ALLOWANCE) return "red"
  if (p95FrameMs > FRAME_120HZ_MS + 0.5) return "amber"
  return "green"
}

export function verdictLabel(verdict: FrameVerdict) {
  if (verdict === "green") return "120hz"
  if (verdict === "amber") return "60hz"
  return "<60hz"
}

// Launch Chromium with vsync and the frame-rate cap disabled so requestAnimationFrame
// fires as fast as the main thread allows. Frame intervals then reflect the time
// spent producing each frame (script + layout + paint), not the display refresh —
// which is what makes the 8.33/16.67 thresholds physically meaningful in headless.
export const frameSamplingLaunchArgs = [
  "--disable-gpu-vsync",
  "--disable-frame-rate-limit",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
]

async function startRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const existing = w.__perfFrames as { stop?: () => void } | undefined
    existing?.stop?.()
    const frames: number[] = []
    const loaf: number[] = []
    let last = performance.now()
    let running = true
    let rafId = 0
    const tick = (t: number) => {
      if (!running) return
      frames.push(t - last)
      last = t
      rafId = requestAnimationFrame(tick)
    }
    last = performance.now()
    rafId = requestAnimationFrame(tick)
    let observer: PerformanceObserver | undefined
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) loaf.push(entry.duration)
      })
      // long-animation-frame captures main-thread blocking >=50ms with attribution.
      observer.observe({ type: "long-animation-frame", buffered: true } as PerformanceObserverInit)
    } catch {
      observer = undefined
    }
    w.__perfFrames = {
      frames,
      loaf,
      stop() {
        running = false
        cancelAnimationFrame(rafId)
        observer?.disconnect()
      },
    }
  })
}

async function stopRecorder(page: Page) {
  return await page
    .evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const rec = w.__perfFrames as { frames: number[]; loaf: number[]; stop: () => void } | undefined
      if (!rec) return { frames: [] as number[], loaf: [] as number[] }
      rec.stop()
      return { frames: rec.frames, loaf: rec.loaf }
    })
    .catch(() => ({ frames: [] as number[], loaf: [] as number[] }))
}

// Record every frame produced while `action` runs, then summarize. The action is
// the real user interaction (a click, a toggle, a drag) driven through Playwright.
export async function measureInteraction(page: Page, label: string, action: () => Promise<void>): Promise<FrameMetric> {
  await startRecorder(page)
  const started = performance.now()
  await action()
  // Let two more frames flush so the final paint is captured.
  await page
    .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    .catch(() => undefined)
  const completionMs = performance.now() - started
  const { frames, loaf } = await stopRecorder(page)
  return buildFrameMetric(label, frames, loaf, completionMs)
}

function buildFrameMetric(label: string, frames: number[], loaf: number[], completionMs: number): FrameMetric {
  // Drop the first interval (recorder warm-up) and fold in any long-animation-frame
  // durations as additional worst-case samples.
  const intervals = frames.slice(1).filter((value) => Number.isFinite(value) && value >= 0)
  const samples = [...intervals, ...loaf.filter((value) => Number.isFinite(value) && value >= 0)]
  const worstFrameMs = samples.length ? Math.max(...samples) : 0
  const p95FrameMs = percentile(samples, 95)
  return {
    label,
    worstFrameMs: round(worstFrameMs),
    p95FrameMs: round(p95FrameMs),
    framesOver833: samples.filter((value) => value > FRAME_120HZ_MS).length,
    framesOver1667: samples.filter((value) => value > FRAME_60HZ_MS).length,
    sampleCount: samples.length,
    completionMs: round(completionMs),
    verdict: verdictFor(p95FrameMs, samples.filter((value) => value > FRAME_60HZ_MS).length),
  }
}

export function mergeFrameMetrics(label: string, metrics: FrameMetric[]): FrameMetric {
  if (metrics.length === 1) return metrics[0]!
  const worstFrameMs = Math.max(0, ...metrics.map((metric) => metric.worstFrameMs))
  const p95FrameMs = Math.max(0, ...metrics.map((metric) => metric.p95FrameMs))
  return {
    label,
    worstFrameMs: round(worstFrameMs),
    p95FrameMs: round(p95FrameMs),
    framesOver833: Math.max(...metrics.map((metric) => metric.framesOver833)),
    framesOver1667: Math.max(...metrics.map((metric) => metric.framesOver1667)),
    sampleCount: metrics.reduce((sum, metric) => sum + metric.sampleCount, 0),
    completionMs: round(metrics.reduce((sum, metric) => sum + metric.completionMs, 0) / metrics.length),
    verdict: verdictFor(p95FrameMs, Math.max(...metrics.map((metric) => metric.framesOver1667))),
  }
}

function percentile(values: number[], rank: number) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.ceil((rank / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
