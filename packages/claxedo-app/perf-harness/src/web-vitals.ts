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
  /**
   * LCP attribution. A bare `lcpMs` cannot be acted on or even trusted: it says
   * nothing about WHICH element was largest, nor whether the number settled
   * during load or kept being revised by content the flow itself painted.
   *
   * The distinction is not cosmetic. The platform stops revising LCP at the
   * first TRUSTED input; synthetic in-page `element.click()` is untrusted and
   * does not stop it. A synthetically driven flow therefore keeps collecting
   * candidates until it ends, and reports "when the largest thing in the whole
   * flow painted" under a name whose thresholds mean "when the page finished
   * loading". `lcpAtFirstTrustedInputMs` is what the platform would report.
   */
  lcpElement?: string
  /** How many times LCP was revised. Load settles; a flow-duration proxy climbs. */
  lcpCandidateCount?: number
  /** LCP frozen at the first trusted input — the real Core Web Vitals value. */
  lcpAtFirstTrustedInputMs?: number
  lcpAtFirstTrustedInputElement?: string
  /** When real input first reached the page. Absent means the flow sent none. */
  firstTrustedInputMs?: number
  /** When synthetic in-page input first fired. These never freeze LCP. */
  firstUntrustedInputMs?: number
  /**
   * CLS recomputed as if the flow's synthetic input had been real.
   *
   * The same trust boundary as LCP, one metric over. A layout shift is excluded
   * from CLS when `hadRecentInput` is set, which Chromium sets only for TRUSTED
   * input in the preceding 500ms — the reasoning being that content moving
   * because the user asked it to is not instability. Synthetic in-page clicks
   * never set it, so a flow driven that way counts every shift its own
   * navigation causes, including the ones a real user's click would have
   * excused. This is what the same flow would score under real input.
   */
  clsExcludingSyntheticInput?: number
  /** Layout shifts observed. Zero here with a non-zero CLS means the cap hit. */
  shiftCount?: number
  /** True if the shift buffer filled, so the recomputed values under-report. */
  shiftsTruncated?: boolean
  /**
   * The raw shifts and synthetic input times the two CLS numbers were scored
   * from. Kept because a derived number nobody can audit is how the earlier
   * rounds of this effort produced results that turned out to be instrument
   * defects — the excusal rule is checkable only against the timestamps.
   */
  shiftSamples?: LayoutShiftSample[]
  syntheticInputTimes?: number[]
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
      // Shifts are kept raw rather than folded into a running CLS, so the same
      // windowing function can score them twice — once as observed, and once
      // with the shifts a real user's input would have excused removed. Two
      // inline accumulators would be two implementations of one rule.
      shifts: [] as { t: number; value: number }[],
      shiftsTruncated: false,
      untrustedInputTimes: [] as number[],
      interactions: new Map<number, number>(),
      // Every candidate, capped so a long flow cannot grow this without bound.
      lcpCandidates: [] as { t: number; size: number; el: string; url?: string }[],
      firstTrustedInputMs: undefined as number | undefined,
      firstUntrustedInputMs: undefined as number | undefined,
    }
    w.__claxedoVitals = state as unknown as Record<string, unknown>

    const observe = (type: string, cb: (entry: PerformanceEntry) => void, extra?: Record<string, unknown>) => {
      try {
        new PerformanceObserver((list) => list.getEntries().forEach(cb))
          .observe({ type, buffered: true, ...extra } as PerformanceObserverInit)
      } catch {}
    }

    // Enough to find the element in source without shipping a serialiser: the
    // testid/slot attributes this app already uses are what a reader greps for.
    const describe = (node: Element | null | undefined) => {
      if (!node) return "<none>"
      const parts = [node.tagName.toLowerCase()]
      const id = node.getAttribute("id")
      if (id) parts.push(`#${id}`)
      for (const attribute of ["data-testid", "data-slot", "data-component"]) {
        const value = node.getAttribute(attribute)
        if (value) parts.push(`[${attribute}=${value}]`)
      }
      const className = node.getAttribute("class")
      if (className) parts.push(`.${className.trim().split(/\s+/).slice(0, 3).join(".")}`)
      const text = (node.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)
      if (text) parts.push(` "${text}"`)
      return parts.join("")
    }

    observe("largest-contentful-paint", (entry) => {
      // Last entry wins: LCP is revised upward as bigger content paints.
      state.lcpMs = entry.startTime
      const candidate = entry as PerformanceEntry & { size?: number; url?: string; element?: Element | null }
      if (state.lcpCandidates.length < 64) {
        state.lcpCandidates.push({
          t: entry.startTime,
          size: candidate.size ?? 0,
          el: describe(candidate.element),
          url: candidate.url || undefined,
        })
      }
    })

    // Which inputs the flow actually delivered. Trusted input freezes LCP;
    // untrusted input is invisible to the platform's own metric machinery, so a
    // flow driven entirely by it produces load metrics that never finalise and
    // an INP of n/a. Recording both tells those two cases apart afterwards.
    for (const type of ["pointerdown", "mousedown", "keydown", "click"]) {
      addEventListener(type, (event: Event) => {
        if (event.isTrusted) {
          if (state.firstTrustedInputMs === undefined) state.firstTrustedInputMs = event.timeStamp
        } else {
          if (state.firstUntrustedInputMs === undefined) state.firstUntrustedInputMs = event.timeStamp
          // Every synthetic input, not just the first: excusing shifts needs the
          // whole set, since each one opens its own 500ms window.
          if (state.untrustedInputTimes.length < 500) state.untrustedInputTimes.push(event.timeStamp)
        }
      }, { capture: true, passive: true })
    }
    observe("paint", (entry) => {
      if (entry.name === "first-contentful-paint") state.fcpMs = entry.startTime
    })
    observe("navigation", (entry) => {
      state.ttfbMs = (entry as PerformanceNavigationTiming).responseStart
    })
    observe("layout-shift", (entry) => {
      const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean }
      // Shifts within 500ms of a real input are the user's doing, not the app's.
      // Chromium already applied that rule here — but only for TRUSTED input.
      if (shift.hadRecentInput) return
      // Bounded so a long flow cannot grow this without limit. Truncation is
      // recorded rather than silent: a capped buffer under-reports CLS, and an
      // under-report that looks like an improvement is the worst failure mode.
      if (state.shifts.length >= 2000) { state.shiftsTruncated = true; return }
      state.shifts.push({ t: shift.startTime, value: shift.value })
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

export type LayoutShiftSample = { t: number; value: number }

/**
 * CLS from raw shifts: the heaviest SESSION, not the running total.
 *
 * Shifts join the current session while they stay within 1s of the previous one
 * and 5s of the session's start; the heaviest session wins. Exported and pure so
 * it can be scored twice over the same evidence — once as observed, once with
 * synthetically-caused shifts excused — without a second copy of the rule.
 */
export function cumulativeLayoutShift(shifts: readonly LayoutShiftSample[]): number {
  let worst = 0
  let sessionValue = 0
  let sessionStart = 0
  let sessionLast = 0
  for (const shift of [...shifts].sort((a, b) => a.t - b.t)) {
    if (sessionValue && shift.t - sessionLast < 1000 && shift.t - sessionStart < 5000) {
      sessionValue += shift.value
      sessionLast = shift.t
    } else {
      sessionValue = shift.value
      sessionStart = shift.t
      sessionLast = shift.t
    }
    if (sessionValue > worst) worst = sessionValue
  }
  return worst
}

/**
 * Drop the shifts a real user's input would have excused.
 *
 * Chromium sets `hadRecentInput` — and so excludes a shift from CLS — when
 * trusted input landed in the preceding 500ms. Synthetic in-page clicks are not
 * trusted, so a harness-driven flow is scored for content that moved BECAUSE
 * the flow asked it to. Applying the platform's own 500ms window to the
 * synthetic inputs recovers what the flow would score under real input.
 */
export function shiftsExcludingRecentInput(
  shifts: readonly LayoutShiftSample[],
  inputTimes: readonly number[],
): LayoutShiftSample[] {
  if (inputTimes.length === 0) return [...shifts]
  return shifts.filter((shift) => !inputTimes.some((at) => shift.t >= at && shift.t - at < 500))
}

/** Read the collected vitals out of the page. Safe to call on a page that never loaded. */
export async function readWebVitals(page: Page): Promise<WebVitals> {
  // The page returns EVIDENCE; scoring happens here. Keeping the derivations out
  // of `page.evaluate` is what lets one implementation of the CLS rule be unit
  // tested — a function serialised into the page cannot be called from a test.
  const raw = await page.evaluate(() => {
    const w = window as typeof window & {
      __claxedoVitals?: {
        lcpMs?: number
        fcpMs?: number
        ttfbMs?: number
        shifts: { t: number; value: number }[]
        shiftsTruncated: boolean
        untrustedInputTimes: number[]
        interactions: Map<number, number>
        lcpCandidates: { t: number; size: number; el: string; url?: string }[]
        firstTrustedInputMs?: number
        firstUntrustedInputMs?: number
      }
    }
    const state = w.__claxedoVitals
    if (!state) return undefined
    return {
      lcpMs: state.lcpMs,
      fcpMs: state.fcpMs,
      ttfbMs: state.ttfbMs,
      shifts: state.shifts ?? [],
      shiftsTruncated: state.shiftsTruncated ?? false,
      untrustedInputTimes: state.untrustedInputTimes ?? [],
      interactionDurations: [...state.interactions.values()],
      lcpCandidates: state.lcpCandidates ?? [],
      firstTrustedInputMs: state.firstTrustedInputMs,
      firstUntrustedInputMs: state.firstUntrustedInputMs,
    }
  }).catch(() => undefined)

  if (!raw) return { interactionCount: 0 }

  const durations = [...raw.interactionDurations].sort((a, b) => b - a)
  // INP is the 98th percentile of interactions, which the spec approximates
  // as "the worst, minus one per 50 interactions". Below 50 that is simply
  // the worst interaction.
  const index = Math.min(durations.length - 1, Math.floor(durations.length / 50))
  const candidates = raw.lcpCandidates
  const trusted = raw.firstTrustedInputMs
  // What the platform would have reported: the last candidate that landed
  // before real input arrived. With no trusted input there is no such moment,
  // and the honest answer is absent rather than the unfrozen number.
  const frozen = trusted === undefined ? undefined : candidates.filter((c) => c.t <= trusted).pop()

  return {
    lcpElement: candidates.length ? candidates[candidates.length - 1]!.el : undefined,
    lcpCandidateCount: candidates.length,
    lcpAtFirstTrustedInputMs: frozen?.t,
    lcpAtFirstTrustedInputElement: frozen?.el,
    firstTrustedInputMs: trusted,
    firstUntrustedInputMs: raw.firstUntrustedInputMs,
    lcpMs: raw.lcpMs,
    fcpMs: raw.fcpMs,
    ttfbMs: raw.ttfbMs,
    cls: cumulativeLayoutShift(raw.shifts),
    clsExcludingSyntheticInput: cumulativeLayoutShift(
      shiftsExcludingRecentInput(raw.shifts, raw.untrustedInputTimes),
    ),
    shiftCount: raw.shifts.length,
    shiftsTruncated: raw.shiftsTruncated || undefined,
    shiftSamples: raw.shifts,
    syntheticInputTimes: raw.untrustedInputTimes,
    inpMs: durations.length ? durations[index] : undefined,
    interactionCount: durations.length,
    worstInteractionMs: durations[0],
  }
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
  // Attribution is per-run EVIDENCE, not a measurement to be pooled. Taking a
  // p75 element identity is meaningless, and pairing one run's element with
  // another run's timing would invent a story no single run told. So the whole
  // attribution set comes from the one run that produced the reported LCP.
  const lcpMs = p75((item) => item.lcpMs)
  const lcpRun = present.find((item) => item.lcpMs === lcpMs) ?? present[present.length - 1]!
  return {
    lcpElement: lcpRun.lcpElement,
    lcpCandidateCount: lcpRun.lcpCandidateCount,
    lcpAtFirstTrustedInputMs: lcpRun.lcpAtFirstTrustedInputMs,
    lcpAtFirstTrustedInputElement: lcpRun.lcpAtFirstTrustedInputElement,
    firstTrustedInputMs: lcpRun.firstTrustedInputMs,
    firstUntrustedInputMs: lcpRun.firstUntrustedInputMs,
    lcpMs,
    fcpMs: p75((item) => item.fcpMs),
    ttfbMs: p75((item) => item.ttfbMs),
    cls: p75((item) => item.cls),
    clsExcludingSyntheticInput: p75((item) => item.clsExcludingSyntheticInput),
    shiftCount: lcpRun.shiftCount,
    shiftSamples: lcpRun.shiftSamples,
    syntheticInputTimes: lcpRun.syntheticInputTimes,
    // Any truncated run taints the merged CLS, so this is an OR across runs
    // rather than one run's flag: a capped buffer under-reports, and a silent
    // under-report reads as stability the flow does not have.
    shiftsTruncated: present.some((item) => item.shiftsTruncated) || undefined,
    inpMs: p75((item) => item.inpMs),
    interactionCount: present.reduce((sum, item) => sum + item.interactionCount, 0),
    worstInteractionMs: present.reduce<number | undefined>(
      (worst, item) => (item.worstInteractionMs ?? 0) > (worst ?? 0) ? item.worstInteractionMs : worst,
      undefined,
    ),
  }
}
