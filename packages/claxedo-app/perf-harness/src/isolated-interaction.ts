import type { Locator, Page } from "playwright-core"
import { measureInteraction, type FrameMetric } from "./frame-sampler"
import type { Measurement } from "./types"

/**
 * Shared owner of ISOLATED per-interaction measurement. One interaction = one
 * trusted pointerdown (or the flow's own triggering event), one page-clock
 * completion, one settle gate before the next interaction starts. There are
 * deliberately NO cumulative clocks across interactions here: every phase's
 * FrameMetric and causal evidence is cropped to its own trusted window by
 * measureInteraction's `armAt: "trusted-pointerdown"` mode.
 *
 * The existing heavy-workspace flow predates this helper and keeps its own
 * inline plumbing; new isolated-interaction scenarios build on this module.
 */

export type TrustedInteractionControl = { mark: string; x: number; y: number }

/**
 * Every isolated interaction reports at least these three facts:
 * - acknowledgedMs: trusted pointerdown -> first visible response (ack latency)
 * - completionMs:  trusted pointerdown -> useful-content settle
 * - timedOut:      the readiness loop hit its bound instead of settling
 */
export type IsolatedInteractionObservation = {
  completionMs: number
  acknowledgedMs?: number
  timedOut: boolean
}

// In-page readiness loops resolve at completion or at this bound; hitting the
// bound is recorded as timedOut evidence rather than throwing mid-measurement.
export const ISOLATED_INTERACTION_TIMEOUT_MS = 10_000

// The settle gate between interactions: this many consecutive rAF frames with
// zero DOM mutations, bounded so a permanently-animating page cannot hang the
// flow (the bound is reported, not silently swallowed).
export const ISOLATED_INTERACTION_SETTLE_QUIET_FRAMES = 5
export const ISOLATED_INTERACTION_SETTLE_TIMEOUT_MS = 4_000

/**
 * Install a once-only trusted-pointerdown performance mark on the control and
 * return the click point for page.mouse. The frame recorder's own
 * trusted-pointerdown arm (frame-sampler) remains the measurement boundary;
 * this mark is the page-clock zero the driver's readiness loop reads elapsed
 * time from, exactly like the heavy-workspace flow's prepare helpers.
 */
export async function prepareTrustedInteraction(
  page: Page,
  control: Locator,
  label: string,
): Promise<TrustedInteractionControl> {
  await control.waitFor({ state: "visible", timeout: 2_000 })
  const mark = `claxedo-perf-${label}-${crypto.randomUUID()}`
  await control.evaluate((node, mark) => {
    performance.clearMarks(mark)
    node.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) performance.mark(mark)
      },
      { once: true },
    )
  }, mark)
  const box = await control.boundingBox()
  if (!box) throw new Error(`Visible control for ${label} had no clickable bounds`)
  return { mark, x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Window-level variant of prepareTrustedInteraction for interactions whose
 * visual target MOVES while the input must land (e.g. interrupting a panel
 * motion: the toggle slides with the workbench column's animated margin, so a
 * coordinate captured up front misses it). The driver clicks a stationary
 * inert point and relays the activation to the moving control synchronously
 * inside the same trusted dispatch; the mark (and the recorder's own arm)
 * still start at the trusted pointerdown's own timestamp.
 */
export async function prepareTrustedWindowInteraction(page: Page, label: string): Promise<{ mark: string }> {
  const mark = `claxedo-perf-${label}-${crypto.randomUUID()}`
  await page.evaluate((mark) => {
    performance.clearMarks(mark)
    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) performance.mark(mark, { startTime: event.timeStamp })
      },
      { once: true, capture: true },
    )
  }, mark)
  return { mark }
}

/**
 * Measure exactly one isolated interaction. `run` performs the trusted input
 * (usually page.mouse.click on a prepared control) plus its in-page readiness
 * loop, and returns the page-clock observation measured from the prepared
 * trusted-pointerdown mark. The recorder is armed at the trusted pointerdown,
 * so setup work before the input never pollutes the sample.
 */
export async function measureIsolatedInteraction<T extends IsolatedInteractionObservation>(
  page: Page,
  label: string,
  run: () => Promise<T>,
): Promise<{ metric: FrameMetric; observation: T }> {
  let observation: T | undefined
  const metric = await measureInteraction(
    page,
    label,
    async () => {
      observation = await run()
      return observation.completionMs
    },
    { armAt: "trusted-pointerdown" },
  )
  if (!observation) throw new Error(`${label} produced no interaction observation`)
  return { metric, observation }
}

/**
 * Explicit settle gate before the NEXT interaction may start: wait for a run
 * of mutation-free animation frames so the next clock cannot inherit trailing
 * work from the previous interaction. Returns whether the page actually
 * settled and how long the gate held, so drivers can report a noisy gap
 * instead of silently blending two interactions.
 */
export async function settleBeforeNextInteraction(page: Page) {
  return await page.evaluate(
    async ({ quietFrames, timeoutMs }) => {
      return await new Promise<{ settled: boolean; waitedMs: number }>((resolve) => {
        const started = performance.now()
        let mutations = 0
        const observer = new MutationObserver((records) => {
          mutations += records.length
        })
        observer.observe(document, { attributes: true, childList: true, subtree: true, characterData: true })
        let quiet = 0
        const tick = () => {
          const dirty = mutations > 0
          mutations = 0
          quiet = dirty ? 0 : quiet + 1
          const waitedMs = performance.now() - started
          if (quiet >= quietFrames) {
            observer.disconnect()
            resolve({ settled: true, waitedMs })
            return
          }
          if (waitedMs >= timeoutMs) {
            observer.disconnect()
            resolve({ settled: false, waitedMs })
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    {
      quietFrames: ISOLATED_INTERACTION_SETTLE_QUIET_FRAMES,
      timeoutMs: ISOLATED_INTERACTION_SETTLE_TIMEOUT_MS,
    },
  )
}

export function measurement(metric: string, value: number, unit = "ms"): Measurement {
  return { metric, value, unit, direction: "lower", samples: [value] }
}

/**
 * Resource requests observed INSIDE the interaction's trusted window (the
 * causal recorder's PerformanceObserver('resource'), cropped to the window).
 * `undefined` means the run had no causal capture, which the evidence gate
 * below reports — never silently read as zero.
 */
export function isolatedInteractionResourceRequests(metric: FrameMetric): number | undefined {
  const resources = metric.causal?.resources
  if (!resources) return undefined
  return resources.filter((resource) => !resource.name.startsWith("data:")).length
}

/**
 * The standard per-interaction bundle, one row namespace per interaction:
 * acknowledgement latency, useful-content completion, JS/style/layout causal
 * attribution, renderer-interval distribution with a STRICT count of intervals
 * over 16.67ms (reported here as a metric; the absolute frame gate stays with
 * the harness's paired base-app gate so a noisy shared host degrades to
 * reported numbers instead of spurious per-interaction failures), DOM mutation
 * counts, and the resource requests observed inside the trusted window.
 */
export function isolatedInteractionMetricRows(
  prefix: string,
  metric: FrameMetric,
  observation: IsolatedInteractionObservation,
): Measurement[] {
  const performance = metric.causal?.performance
  const dom = metric.causal?.dom
  const resources = metric.causal?.resources
  return [
    ...(observation.acknowledgedMs !== undefined
      ? [measurement(`${prefix}_ack_ms`, round(observation.acknowledgedMs))]
      : []),
    measurement(`${prefix}_completion_ms`, round(observation.completionMs)),
    measurement(`${prefix}_timed_out`, observation.timedOut ? 1 : 0, "count"),
    ...(performance
      ? [
          measurement(`${prefix}_script_ms`, performance.scriptMs ?? 0),
          measurement(`${prefix}_style_ms`, performance.recalcStyleMs ?? 0),
          measurement(`${prefix}_layout_ms`, performance.layoutMs ?? 0),
          measurement(`${prefix}_task_ms`, performance.taskMs ?? 0),
        ]
      : []),
    measurement(`${prefix}_p95_renderer_interval_ms`, metric.p95FrameMs),
    measurement(`${prefix}_worst_renderer_interval_ms`, metric.worstFrameMs),
    measurement(`${prefix}_renderer_intervals_over_16_67_ms`, metric.framesOver1667, "count"),
    measurement(`${prefix}_renderer_interval_samples`, metric.sampleCount, "count"),
    ...(dom
      ? [
          measurement(`${prefix}_attribute_mutations`, dom.attributesChanged, "count"),
          measurement(`${prefix}_nodes_added`, dom.nodesAdded, "count"),
          measurement(`${prefix}_nodes_removed`, dom.nodesRemoved, "count"),
        ]
      : []),
    ...(resources
      ? [
          measurement(`${prefix}_resource_requests`, isolatedInteractionResourceRequests(metric) ?? 0, "count"),
          measurement(
            `${prefix}_resource_transfer_bytes`,
            resources.reduce((sum, resource) => sum + resource.transferSize, 0),
            "bytes",
          ),
        ]
      : []),
  ]
}

/**
 * Causal-evidence requirement for an isolated interaction, mirroring the
 * heavy-workspace flow's rule: these scenarios are measured with
 * CLAXEDO_PERF_CAUSAL=1 so attribution and resource evidence exist; a run
 * without that evidence is a validation failure, not a silently thinner one.
 */
export function isolatedInteractionEvidenceFailures(phase: string, metric: FrameMetric) {
  if (!metric.causal) return [`${phase} has no causal measurement; set CLAXEDO_PERF_CAUSAL=1`]
  const failures: string[] = []
  if (metric.causal.performanceSource !== "trusted-window-trace" || !metric.causal.performance) {
    failures.push(
      `${phase} has no exact trusted-window renderer work: ${metric.causal.performanceUnavailableReason ?? "unknown reason"}`,
    )
  }
  if (!metric.mainThreadTasksMs?.length) {
    failures.push(`${phase} trace contained no renderer task samples`)
  }
  return failures
}

/**
 * The interaction must actually respond and settle: a missing acknowledgement
 * or a readiness-loop timeout invalidates the measurement.
 */
export function isolatedInteractionSettleFailures(phase: string, observation: IsolatedInteractionObservation) {
  const failures: string[] = []
  if (observation.acknowledgedMs === undefined) {
    failures.push(`${phase} never produced a visible acknowledgement`)
  }
  if (observation.timedOut) {
    failures.push(`${phase} did not settle before the ${ISOLATED_INTERACTION_TIMEOUT_MS}ms readiness bound`)
  }
  return failures
}

/**
 * Hard zero-request gate for interactions whose data is genuinely already
 * loaded. Unobserved (no causal capture) is itself a failure so the gate can
 * never pass vacuously. Interactions that may legitimately fetch (first data
 * load, on-demand file content) report their count instead of using this.
 */
export function alreadyLoadedResourceRequestFailures(phase: string, requests: number | undefined) {
  if (requests === undefined) {
    return [`${phase} resource requests were unobserved; set CLAXEDO_PERF_CAUSAL=1`]
  }
  return requests === 0
    ? []
    : [`${phase} issued ${requests} resource requests; expected 0 for already-loaded data`]
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
