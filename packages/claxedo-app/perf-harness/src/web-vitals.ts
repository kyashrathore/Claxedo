import type { Page } from "playwright-core"

/**
 * Core Web Vitals, collected in-page.
 *
 * Distinct in kind from the rest of this harness. `FrameMetric` measures
 * renderer scheduling — how evenly the main thread ticks — which is a proxy the
 * user never directly perceives. These are the metrics that describe what the
 * user actually experiences: when content appeared (LCP/FCP), whether it moved
 * under them (CLS), and how long the UI took to answer an input (INP).
 *
 * Gathered with the same definitions the web platform uses, not
 * re-derived: LCP from the last `largest-contentful-paint` entry, CLS as the
 * heaviest 1s-gap/5s-window session of `layout-shift` entries, INP from
 * `event` entries grouped by `interactionId`. The `web-vitals` library is not
 * a dependency here — the harness deliberately ships no runtime into the page
 * beyond this, so the app under measurement stays the app that ships.
 */
export type WebVitals = {
  lcpMs?: number
  fcpMs?: number
  ttfbMs?: number
  cls?: number
  inpMs?: number
  /** Interaction count behind INP; an INP from very few interactions is weak evidence. */
  interactionCount: number
  /** Longest single interaction, for the tail the p98-style INP estimate hides. */
  worstInteractionMs?: number
}

/**
 * Install before any app script runs, so nothing is missed.
 *
 * `buffered: true` recovers entries dispatched before the observer attached,
 * but only for types that keep a buffer, and only within the same document —
 * an init script is the one place all four types can be observed from zero.
 */
export async function installWebVitals(page: Page) {
  await page.addInitScript(() => {
    const w = window as typeof window & { __claxedoVitals?: Record<string, unknown> }
    const state = {
      lcpMs: undefined as number | undefined,
      fcpMs: undefined as number | undefined,
      ttfbMs: undefined as number | undefined,
      clsValue: 0,
      // CLS is the WORST session window, not the running total: shifts are
      // grouped while they stay within 1s of each other and 5s of the group's
      // start, and the heaviest group wins.
      sessionValue: 0,
      sessionStart: 0,
      sessionLast: 0,
      interactions: new Map<number, number>(),
    }
    w.__claxedoVitals = state as unknown as Record<string, unknown>

    const observe = (type: string, cb: (entry: PerformanceEntry) => void, extra?: Record<string, unknown>) => {
      try {
        new PerformanceObserver((list) => list.getEntries().forEach(cb))
          .observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
      } catch {}
    }

    observe("largest-contentful-paint", (entry) => {
      // Last entry wins: LCP is revised upward as bigger content paints.
      state.lcpMs = entry.startTime
    })
    observe("paint", (entry) => {
      if (entry.name === "first-contentful-paint") state.fcpMs = entry.startTime
    })
    observe("navigation", (entry) => {
      state.ttfbMs = (entry as PerformanceNavigationTiming).responseStart
    })
    observe("layout-shift", (entry) => {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
      // Shifts within 500ms of a real input are the user's doing, not the app's.
      if (shift.hadRecentInput) return
      const t = shift.startTime
      if (state.sessionValue && t - state.sessionLast < 1000 && t - state.sessionStart < 5000) {
        state.sessionValue += shift.value
        state.sessionLast = t
      } else {
        state.sessionValue = shift.value
        state.sessionStart = t
        state.sessionLast = t
      }
      if (state.sessionValue > state.clsValue) state.clsValue = state.sessionValue
    })
    // `durationThreshold: 0` reports every interaction; the default (104ms)
    // would hide exactly the sub-threshold spread INP is meant to summarise.
    observe("event", (entry) => {
      const event = entry as PerformanceEntry & { interactionId?: number }
      if (!event.interactionId) return
      const previous = state.interactions.get(event.interactionId) ?? 0
      // One interaction spans several events (pointerdown/up/click); its
      // latency is the longest of them, not their sum.
      if (entry.duration > previous) state.interactions.set(event.interactionId, entry.duration)
    }, { durationThreshold: 0 })
  })
}

/** Read the collected vitals out of the page. Safe to call on a page that never loaded. */
export async function readWebVitals(page: Page): Promise<WebVitals> {
  return page.evaluate(() => {
    const w = window as typeof window & {
      __claxedoVitals?: {
        lcpMs?: number
        fcpMs?: number
        ttfbMs?: number
        clsValue: number
        interactions: Map<number, number>
      }
    }
    const state = w.__claxedoVitals
    if (!state) return { interactionCount: 0 }
    const durations = [...state.interactions.values()].sort((a, b) => b - a)
    // INP is the 98th percentile of interactions, which the spec approximates
    // as "the worst, minus one per 50 interactions". Below 50 that is simply
    // the worst interaction.
    const index = Math.min(durations.length - 1, Math.floor(durations.length / 50))
    return {
      lcpMs: state.lcpMs,
      fcpMs: state.fcpMs,
      ttfbMs: state.ttfbMs,
      cls: state.clsValue,
      inpMs: durations.length ? durations[index] : undefined,
      interactionCount: durations.length,
      worstInteractionMs: durations[0],
    }
  }).catch(() => ({ interactionCount: 0 }))
}

/** Google's "good" thresholds. `poor` is the far edge; between the two is "needs improvement". */
export const WEB_VITAL_THRESHOLDS = {
  lcpMs: { good: 2500, poor: 4000 },
  inpMs: { good: 200, poor: 500 },
  cls: { good: 0.1, poor: 0.25 },
  fcpMs: { good: 1800, poor: 3000 },
  ttfbMs: { good: 800, poor: 1800 },
} as const

export function webVitalRating(metric: keyof typeof WEB_VITAL_THRESHOLDS, value: number | undefined) {
  if (value === undefined) return "n/a" as const
  const { good, poor } = WEB_VITAL_THRESHOLDS[metric]
  if (value <= good) return "good" as const
  return value <= poor ? "needs-improvement" as const : "poor" as const
}

/**
 * Combine vitals across iterations of one flow.
 *
 * p75, which is how Core Web Vitals are defined in the field: a page is "good"
 * when 75% of visits are good, so the 75th percentile is the number the metric
 * is scored on. It also avoids the two biases at the extremes — a mean lets one
 * fast run hide a slow one, while a max gets monotonically worse the more
 * iterations you run, making runs of different lengths incomparable.
 *
 * `interactionCount` sums instead: it is evidence about the sample, not a
 * measurement of it, and the question it answers ("was there enough input to
 * trust INP?") is about the whole set.
 */
export function mergeWebVitals(runs: readonly WebVitals[]): WebVitals {
  const present = runs.filter(Boolean)
  if (present.length === 0) return { interactionCount: 0 }
  const p75 = (pick: (item: WebVitals) => number | undefined) => {
    const values = present.map(pick).filter((value): value is number => typeof value === "number")
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.75) - 1)]
  }
  return {
    lcpMs: p75((item) => item.lcpMs),
    fcpMs: p75((item) => item.fcpMs),
    ttfbMs: p75((item) => item.ttfbMs),
    cls: p75((item) => item.cls),
    inpMs: p75((item) => item.inpMs),
    interactionCount: present.reduce((sum, item) => sum + item.interactionCount, 0),
    worstInteractionMs: present.reduce<number | undefined>(
      (worst, item) => (item.worstInteractionMs ?? 0) > (worst ?? 0) ? item.worstInteractionMs : worst,
      undefined,
    ),
  }
}
