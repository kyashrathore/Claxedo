import type { Browser, CDPSession, Page } from "playwright-core"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  sessionPath,
  type BrowserTarget,
} from "./browser-runner"
import { applyCpuProfile, applyNetworkProfile, type EnvironmentProfile } from "./environment-profile"
import { METRICS, type PerfRecord } from "./perf-record"
import { captureHeapSnapshot } from "./heap-snapshot"

/**
 * The memory lane.
 *
 * Answers a different question from the browser lane, and the difference is the
 * whole design. A flow measures how long something took ONCE; this measures
 * whether repeating it forever costs anything — whether retained memory
 * PLATEAUS. A single "how much memory does it use" number cannot answer that,
 * because the answer is always "more than yesterday, a bit".
 *
 * Two rules keep the numbers honest, both learned by getting them wrong:
 *
 *  1. Navigate IN-APP. An earlier attempt drove the sweep with `page.goto`,
 *     which reloads the document and discards the heap, so retention looked
 *     perfectly flat at 22MB while nothing accumulated at all — a false pass
 *     that also showed one mounted tab and no rendered session. Real
   *     accumulation only happens across client-side navigations, so the sweep
   *     clicks the canonical rail control and exercises its real activation,
   *     prefetch, cancellation, workbench, and URL-update lifecycle.
 *  2. Sample AFTER a forced collection. Without it the curve is dominated by
 *     garbage awaiting collection, which rises and falls on the collector's
 *     schedule rather than the app's retention.
 */

export type MemorySample = {
  step: number
  heapBytes: number
  /** V8 embedder heap, when the Chromium protocol exposes it. */
  embedderHeapBytes?: number
  /** ArrayBuffer/string backing-store bytes, when exposed by Chromium. */
  backingStorageBytes?: number
  /** Elements attached to the current main document only. */
  documentElements: number
  queries: number
  /** Session IDs retaining a heavy render surface under the product policy. */
  cachedSessions: number
  /** Session IDs represented only by lightweight status/request rail metadata. */
  lightweightSessions: number
  /** Query-cache entries per key family, so growth attributes to a structure. */
  families: Record<string, number>
  /**
   * Browser-side live counters. They corroborate growth but do not identify
   * leaks by themselves: `nodes` includes attached and detached DOM across all
   * live documents, and listeners may belong to either. Exact detachedness
   * comes only from the V8 heap-snapshot flag.
   */
  documents: number
  liveDomNodes: number
  liveListeners: number
}

export type MemorySweepMode = "normal" | "rapid"

export type MemorySettlement = {
  samples: MemorySample[]
  stable: boolean
  /** The product contract. Diagnostic display thresholds cannot change this. */
  cacheCeilingSatisfied: boolean
  diagnosticCacheCeilingSatisfied: boolean
}

/** A sweep's shape, which is what "does it plateau" is actually asking. */
export type MemorySweep = {
  flow: string
  mode: MemorySweepMode
  samples: MemorySample[]
  settlement: MemorySettlement
  /** Retained bytes per additional session over the tail of the sweep. */
  slopeBytesPerStep?: number
  plateauBytes: number
}

export type MemorySweepSummary = {
  flow: string
  mode: MemorySweepMode
  sweeps: MemorySweep[]
  slopeBytesPerStep?: number
  slopeMinBytesPerStep?: number
  slopeMaxBytesPerStep?: number
  plateauBytes: number
  slopeSupported: boolean
  allSettled: boolean
  cacheCeilingSatisfied: boolean
}

export type MemoryRunValidity = {
  status: "valid" | "invalid"
  reasons: string[]
}

export function memoryRunValidity(input: {
  summary: Pick<MemorySweepSummary, "allSettled" | "cacheCeilingSatisfied" | "slopeSupported">
  repetitionsSufficient: boolean
  sourceStable: boolean
  snapshotAvailable: boolean
}): MemoryRunValidity {
  const reasons = [
    ...(!input.summary.slopeSupported ? ["underdetermined-slope"] : []),
    ...(!input.summary.allSettled ? ["settlement-unstable"] : []),
    ...(!input.summary.cacheCeilingSatisfied ? ["product-cache-ceiling-exceeded"] : []),
    ...(!input.repetitionsSufficient ? ["insufficient-repetitions"] : []),
    ...(!input.sourceStable ? ["source-changed"] : []),
    ...(!input.snapshotAvailable ? ["snapshot-unsupported"] : []),
  ]
  return { status: reasons.length ? "invalid" : "valid", reasons }
}

export function memoryComparisonPublishable(validity: MemoryRunValidity) {
  return validity.status === "valid"
}

export function memorySessionQueryCounts(
  keys: readonly (readonly unknown[])[],
  isSurfaceQueryKey: (key: readonly unknown[]) => boolean,
) {
  const surfaceSessionIds = new Set<string>()
  const lightweightSessionIds = new Set<string>()
  for (const key of keys) {
    if (key[0] !== "shell" || key[1] !== "session" || typeof key[2] !== "string") continue
    if (isSurfaceQueryKey(key)) surfaceSessionIds.add(key[2])
    else if (key[2] && key[2] !== "new" && (key[3] === "status" || key[3] === "requests")) {
      lightweightSessionIds.add(key[2])
    }
  }
  return {
    cachedSessions: surfaceSessionIds.size,
    lightweightSessions: lightweightSessionIds.size,
  }
}

// `performance.memory` is NOT usable here. Chrome quantises it and caches the
// value for privacy, so a sweep that doubled its DOM nodes and grew its query
// cache from 125 to 428 entries reported an identical 31.6MB at every sample.
// Heap comes from CDP `Runtime.getHeapUsage` instead, which reports the real
// post-collection figure; the in-page probe keeps only what the page alone
// knows (its own retention counters).
const MEMORY_SESSION_QUERY_COUNTS_SOURCE = memorySessionQueryCounts.toString()

const PROBE = `(() => {
  const qc = window.__claxedoQueryClient
  const classifySurface = window.__claxedoSessionCachePolicy?.isSurfaceQueryKey
  if (typeof classifySurface !== "function") {
    throw new Error("Product session-cache policy is unavailable to the memory probe")
  }
  const all = qc ? qc.getQueryCache().getAll() : []
  const sessionCounts = (${MEMORY_SESSION_QUERY_COUNTS_SOURCE})(
    all.map((query) => query.queryKey).filter(Array.isArray),
    classifySurface,
  )
  // Group by key family, not just count. "Queries grew" is a symptom; the
  // family that grew is the defect, and without this the next step is a
  // guess about which cache is unbounded.
  const families = {}
  for (const q of all) {
    const k = q.queryKey
    const family = Array.isArray(k)
      ? [k[0], typeof k[2] === "string" && k[0] === "shell" ? k[1] : undefined].filter(Boolean).join(".")
      : "other"
    families[family] = (families[family] || 0) + 1
  }
  return {
    documentElements: document.getElementsByTagName("*").length,
    queries: all.length,
    ...sessionCounts,
    families,
  }
})()`

/**
 * Fit the TAIL, not the whole sweep.
 *
 * The first visits are startup: chunks evaluate, caches warm, the shell mounts.
 * Including them makes every sweep look like it is growing, because at the
 * start it genuinely is. What the ceiling promises is about steady state, so
 * the slope is measured over the last two thirds.
 */
export const PRODUCT_SESSION_CACHE_LIMIT = 40
export const MIN_SLOPE_POST_CLICK_SAMPLES = 3

export function parseMemoryInteger(name: string, raw: string | number | undefined, minimum: number) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Invalid ${name}: expected a safe integer >= ${minimum}, received ${String(raw)}`)
  }
  return value
}

export function tailSlope(samples: readonly MemorySample[]): number | undefined {
  const postClick = samples.filter((sample) => sample.step > 0)
  const tail = postClick.slice(Math.floor(postClick.length / 3))
  const unique = [...new Map(tail.map((sample) => [sample.step, sample])).values()]
  if (unique.length < MIN_SLOPE_POST_CLICK_SAMPLES) return undefined
  const meanStep = unique.reduce((sum, sample) => sum + sample.step, 0) / unique.length
  const meanHeap = unique.reduce((sum, sample) => sum + sample.heapBytes, 0) / unique.length
  const covariance = unique.reduce(
    (sum, sample) => sum + (sample.step - meanStep) * (sample.heapBytes - meanHeap),
    0,
  )
  const variance = unique.reduce((sum, sample) => sum + (sample.step - meanStep) ** 2, 0)
  return variance === 0 ? undefined : covariance / variance
}

async function sample(page: Page, cdp: CDPSession, step: number): Promise<MemorySample> {
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(150)
  // Narrow to what the PAGE can know. Typing this as the whole sample minus
  // heap made the spread below silently shadow the CDP counters with fields
  // the page never returns.
  const probe = await page.evaluate(PROBE) as Pick<
    MemorySample, "documentElements" | "queries" | "cachedSessions" | "lightweightSessions" | "families"
  >
  const usage = await cdp.send("Runtime.getHeapUsage") as {
    usedSize: number
    embedderHeapUsedSize?: number
    backingStorageSize?: number
  }
  const counters = await cdp.send("Memory.getDOMCounters") as {
    documents: number; nodes: number; jsEventListeners: number
  }
  return {
    step,
    heapBytes: usage.usedSize,
    ...(usage.embedderHeapUsedSize === undefined ? {} : { embedderHeapBytes: usage.embedderHeapUsedSize }),
    ...(usage.backingStorageSize === undefined ? {} : { backingStorageBytes: usage.backingStorageSize }),
    documents: counters.documents,
    liveDomNodes: counters.nodes,
    liveListeners: counters.jsEventListeners,
    ...probe,
  }
}

const STABLE_SAMPLE_COUNT = 3
export const MEMORY_CACHE_SETTLE_MINIMUM_MS = 2_500

/** Quiescence is a repeated observation, not a fixed sleep with a hopeful name. */
export function memorySamplesStable(samples: readonly MemorySample[]) {
  const window = samples.slice(-STABLE_SAMPLE_COUNT)
  if (window.length < STABLE_SAMPLE_COUNT) return false
  const heaps = window.map((item) => item.heapBytes)
  const heapRange = Math.max(...heaps) - Math.min(...heaps)
  const heapMean = heaps.reduce((sum, value) => sum + value, 0) / heaps.length
  const exact = (read: (sample: MemorySample) => number) => new Set(window.map(read)).size === 1
  return heapRange <= Math.max(256 * 1024, heapMean * 0.01) &&
    exact((item) => item.queries) &&
    exact((item) => item.cachedSessions) &&
    exact((item) => item.lightweightSessions) &&
    exact((item) => item.liveListeners) &&
    exact((item) => item.liveDomNodes) &&
    exact((item) => item.documents) &&
    exact((item) => item.documentElements)
}

export function memoryVisitOrder<T>(sessions: readonly T[]) {
  // Caller supplies rail / created_desc order; click top→bottom without rotating
  // the first row to the end (that looked like random jumping in headed runs).
  return [...sessions]
}

export function needsFinalMemorySample(samples: readonly Pick<MemorySample, "step">[], finalStep: number) {
  return samples.at(-1)?.step !== finalStep
}

export function memoryCacheCeilingStatus(cachedSessions: number, diagnosticCeiling: number) {
  return {
    cacheCeilingSatisfied: cachedSessions <= PRODUCT_SESSION_CACHE_LIMIT,
    diagnosticCacheCeilingSatisfied: cachedSessions <= diagnosticCeiling,
  }
}

export function sessionActivationSelector(sessionId: string) {
  return `[data-testid="rail-sidebar-session-row"][data-session-id=${JSON.stringify(sessionId)}]:visible`
}

async function activateSession(page: Page, sessionId: string) {
  const row = page.locator(sessionActivationSelector(sessionId)).first()
  await row.waitFor({ state: "visible", timeout: 10_000 })
  await row.scrollIntoViewIfNeeded()
  const activate = row.locator('[data-slot="navigation-row-activate"]').first()
  if (!await activate.count()) throw new Error(`Session ${sessionId} has no canonical navigation activate control`)
  await activate.click({ timeout: 10_000 })
  await page.waitForFunction((id) =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="rail-sidebar-session-row"]')]
      .some((item) => item.dataset.sessionId === id && item.dataset.active === "true"), sessionId, { timeout: 10_000 })
}

async function waitForSessionMessages(page: Page, sessionId: string) {
  await page.locator(
    `[data-testid="session-page-root"][data-session-id=${JSON.stringify(sessionId)}][data-session-messages-ready="true"]:visible`,
  ).first().waitFor({ state: "visible", timeout: 10_000 })
}

async function settleMemory(input: {
  page: Page
  cdp: CDPSession
  step: number
  cacheCeiling: number
  minimumMs: number
  timeoutMs: number
}): Promise<MemorySettlement> {
  await input.page.waitForTimeout(input.minimumMs)
  const samples: MemorySample[] = []
  const started = Date.now()
  while (Date.now() - started <= input.timeoutMs) {
    samples.push(await sample(input.page, input.cdp, input.step))
    if (memorySamplesStable(samples)) break
    await input.page.waitForTimeout(500)
  }
  const last = samples.at(-1)
  return {
    samples,
    stable: memorySamplesStable(samples),
    ...(last
      ? memoryCacheCeilingStatus(last.cachedSessions, input.cacheCeiling)
      : { cacheCeilingSatisfied: false, diagnosticCacheCeilingSatisfied: false }),
  }
}

/**
 * Sweep session visits under mixed load and watch retention.
 *
 * The fixture spreads its sessions across several workspace directories, so a
 * sweep exercises the axes that actually interact: many sessions, several
 * workspaces, and the per-session caches each visit leaves behind.
 */
export async function runMemorySweep(input: {
  browser: Browser
  app: BrowserTarget
  profile: EnvironmentProfile
  sessions: number
  sampleEvery: number
  mode?: MemorySweepMode
  normalDwellMs?: number
  rapidDwellMs?: number
  cacheCeiling?: number
  settleMinimumMs?: number
  settleTimeoutMs?: number
  /** Capture a heap snapshot at the end of the sweep, for retainer analysis. */
  snapshotPath?: string
}): Promise<MemorySweep> {
  const fixture = fixtureFor("workspace-switch", {
    repos: 1, projects: 5, sessions: parseMemoryInteger("sessions", input.sessions, 2), messages: 400,
    terminals: 0, changed_files: 0, themes: ["claxedo-dark"], agent_actions: 0, mask_keys: [],
  })
  const context = await input.browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send("HeapProfiler.enable")
  await applyCpuProfile(cdp, input.profile)
  await applyNetworkProfile(cdp, input.profile)
  // The mock installer logs into a page monitor; this lane does not assert on
  // console/network failures, so it supplies an inert sink rather than
  // widening the installer's contract for one caller.
  const monitor = {
    pageErrors: [] as string[], consoleErrors: [] as string[], failedResponses: [] as string[],
    failedRequests: [] as string[], unmatchedMockPaths: [] as string[],
  }
  await installMockApi(page, input.app, fixture, monitor, input.profile)
  await installSeedState(page, input.app, fixture)

  const mode = input.mode ?? "normal"
  const first = fixture.sessions[0]!
  await page.goto(`${input.app.baseUrl}${sessionPath(first, first.id)}`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-claxedo]", { timeout: 30_000 })
  await page.waitForTimeout(1_500)
  if (mode === "normal") await waitForSessionMessages(page, first.id)

  const samples: MemorySample[] = [await sample(page, cdp, 0)]
  const visits = memoryVisitOrder(fixture.sessions)
  for (const [index, session] of visits.entries()) {
    // Drive the public, trusted control. Besides route selection, pointerdown
    // owns prefetch cancellation and click owns workbench/layout activation.
    await activateSession(page, session.id)
    if (mode === "normal") await waitForSessionMessages(page, session.id)
    await page.waitForTimeout(mode === "rapid" ? (input.rapidDwellMs ?? 120) : (input.normalDwellMs ?? 750))
    if ((index + 1) % input.sampleEvery === 0) samples.push(await sample(page, cdp, index + 1))
  }
  if (needsFinalMemorySample(samples, visits.length)) samples.push(await sample(page, cdp, visits.length))
  // The app's cache ceiling waits >=250ms and may wait for requestIdleCallback's
  // 2s timeout. Observe until the counters and forced-GC heap actually stop
  // moving rather than declaring one fixed-delay sample a plateau.
  const settlement = await settleMemory({
    page,
    cdp,
    step: visits.length,
    cacheCeiling: input.cacheCeiling ?? PRODUCT_SESSION_CACHE_LIMIT,
    minimumMs: Math.max(MEMORY_CACHE_SETTLE_MINIMUM_MS, input.settleMinimumMs ?? 0),
    timeoutMs: input.settleTimeoutMs ?? 8_000,
  })
  // Taken AFTER the settle and the final collection, so anything in it is
  // genuinely retained rather than merely uncollected.
  if (input.snapshotPath) await captureHeapSnapshot(cdp, input.snapshotPath)
  await context.close()

  const plateau = settlement.samples.at(-1) ?? samples.at(-1)!
  return {
    flow: mode === "rapid" ? "session-accumulation-rapid-click-v2" : "session-accumulation-normal-click-v2",
    mode,
    samples,
    settlement,
    slopeBytesPerStep: tailSlope(samples),
    plateauBytes: plateau.heapBytes,
  }
}

function median(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

export function summarizeMemorySweeps(sweeps: readonly MemorySweep[]): MemorySweepSummary {
  const first = sweeps[0]
  if (!first) throw new Error("Cannot summarize zero memory sweeps")
  if (sweeps.some((sweep) => sweep.flow !== first.flow || sweep.mode !== first.mode)) {
    throw new Error("Cannot pool memory sweeps with different flow contracts")
  }
  const slopes = sweeps.flatMap((sweep) => sweep.slopeBytesPerStep === undefined ? [] : [sweep.slopeBytesPerStep])
  const plateaus = sweeps.map((sweep) => sweep.plateauBytes)
  return {
    flow: first.flow,
    mode: first.mode,
    sweeps: [...sweeps],
    ...(slopes.length === sweeps.length
      ? {
        slopeBytesPerStep: median(slopes),
        slopeMinBytesPerStep: Math.min(...slopes),
        slopeMaxBytesPerStep: Math.max(...slopes),
      }
      : {}),
    plateauBytes: median(plateaus),
    slopeSupported: slopes.length === sweeps.length,
    allSettled: sweeps.every((sweep) => sweep.settlement.stable),
    cacheCeilingSatisfied: sweeps.every((sweep) => sweep.settlement.cacheCeilingSatisfied),
  }
}

/** Project repeated sweeps onto the portable contract, so variance is preserved. */
export function memoryRecords(summary: MemorySweepSummary, stack: string, profile: string): PerfRecord[] {
  const slopes = summary.sweeps.flatMap((sweep) => sweep.slopeBytesPerStep === undefined ? [] : [sweep.slopeBytesPerStep])
  const plateaus = summary.sweeps.map((sweep) => sweep.plateauBytes)
  return [
    {
      lane: "memory", flow: summary.flow, metric: "retained_heap_bytes_per_visit",
      value: summary.slopeBytesPerStep,
      unit: METRICS.retained_heap_bytes_per_visit!.unit,
      samples: slopes, stack, profile,
      ...(summary.slopeSupported ? {} : {
        absentReason: `Need at least ${MIN_SLOPE_POST_CLICK_SAMPLES} distinct post-click tail samples per repetition`,
      }),
    },
    {
      lane: "memory", flow: summary.flow, metric: "retained_heap_bytes",
      value: summary.plateauBytes, unit: METRICS.retained_heap_bytes!.unit,
      samples: plateaus, stack, profile,
    },
  ]
}
