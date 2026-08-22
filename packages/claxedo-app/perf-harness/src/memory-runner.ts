import type { Browser, CDPSession, Page } from "playwright-core"
import {
  fixtureFor,
  installMockApi,
  installSeedState,
  sessionPath,
  workspacePath,
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
 *     uses pushState + popstate, the same mechanism the app's own router sees.
 *  2. Sample AFTER a forced collection. Without it the curve is dominated by
 *     garbage awaiting collection, which rises and falls on the collector's
 *     schedule rather than the app's retention.
 */

export type MemorySample = {
  step: number
  heapBytes: number
  domNodes: number
  queries: number
  cachedSessions: number
  /** Query-cache entries per key family, so growth attributes to a structure. */
  families: Record<string, number>
  /**
   * Browser-side counters. The query cache gained ~2 entries per visit while
   * the heap gained ~200kB, so the growth is not cache entries — it is either
   * DOM the page never released, or listeners bound to it. `documents` rising
   * is the signature of detached documents; `jsEventListeners` rising without
   * `nodes` is a listener leak.
   */
  documents: number
  nodes: number
  listeners: number
}

/** A sweep's shape, which is what "does it plateau" is actually asking. */
export type MemorySweep = {
  flow: string
  samples: MemorySample[]
  /** Retained bytes per additional session over the tail of the sweep. */
  slopeBytesPerStep: number
  plateauBytes: number
}

// `performance.memory` is NOT usable here. Chrome quantises it and caches the
// value for privacy, so a sweep that doubled its DOM nodes and grew its query
// cache from 125 to 428 entries reported an identical 31.6MB at every sample.
// Heap comes from CDP `Runtime.getHeapUsage` instead, which reports the real
// post-collection figure; the in-page probe keeps only what the page alone
// knows (its own retention counters).
const PROBE = `(() => {
  const qc = window.__claxedoQueryClient
  const all = qc ? qc.getQueryCache().getAll() : []
  const sessionIds = new Set()
  for (const q of all) {
    const k = q.queryKey
    if (Array.isArray(k) && k[0] === "shell" && k[1] === "session" && typeof k[2] === "string") sessionIds.add(k[2])
  }
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
    domNodes: document.getElementsByTagName("*").length,
    queries: all.length,
    cachedSessions: sessionIds.size,
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
/**
 * Nodes the browser still holds that the document no longer contains.
 *
 * `Memory.getDOMCounters` counts every live node; the page's own
 * `getElementsByTagName("*")` counts only attached ones. The gap is DOM that
 * was removed but is still referenced — by a listener, a closure, an
 * undisposed reactive root — and so is never collected. It is invisible to
 * every counter the page can read about itself, which is why a sweep that
 * watched only the query cache concluded the app was fine.
 */
export function detachedNodes(sample: Pick<MemorySample, "nodes" | "domNodes">) {
  return Math.max(0, sample.nodes - sample.domNodes)
}

export function tailSlope(samples: readonly MemorySample[]) {
  const tail = samples.slice(Math.floor(samples.length / 3))
  if (tail.length < 2) return 0
  const first = tail[0]!
  const last = tail[tail.length - 1]!
  const steps = last.step - first.step
  return steps === 0 ? 0 : (last.heapBytes - first.heapBytes) / steps
}

async function sample(page: Page, cdp: CDPSession, step: number): Promise<MemorySample> {
  await cdp.send("HeapProfiler.collectGarbage")
  await page.waitForTimeout(150)
  // Narrow to what the PAGE can know. Typing this as the whole sample minus
  // heap made the spread below silently shadow the CDP counters with fields
  // the page never returns.
  const probe = await page.evaluate(PROBE) as Pick<
    MemorySample, "domNodes" | "queries" | "cachedSessions" | "families"
  >
  const usage = await cdp.send("Runtime.getHeapUsage") as { usedSize: number }
  const counters = await cdp.send("Memory.getDOMCounters") as {
    documents: number; nodes: number; jsEventListeners: number
  }
  return {
    step, heapBytes: usage.usedSize,
    documents: counters.documents, nodes: counters.nodes, listeners: counters.jsEventListeners,
    ...probe,
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
  /** Capture a heap snapshot at the end of the sweep, for retainer analysis. */
  snapshotPath?: string
}): Promise<MemorySweep> {
  const fixture = fixtureFor("workspace-switch", {
    repos: 1, projects: 5, sessions: input.sessions, messages: 400,
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

  const first = fixture.sessions[0]!
  await page.goto(`${input.app.baseUrl}${sessionPath(first, first.id)}`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-claxedo]", { timeout: 30_000 })
  await page.waitForTimeout(1_500)

  const samples: MemorySample[] = [await sample(page, cdp, 0)]
  for (const [index, session] of fixture.sessions.entries()) {
    // Client-side navigation only. A `page.goto` here would reset the heap and
    // turn the whole measurement into a tautology.
    await page.evaluate((pathName) => {
      history.pushState({}, "", pathName)
      window.dispatchEvent(new PopStateEvent("popstate"))
    }, sessionPath(session, session.id))
    await page.waitForTimeout(120)
    if ((index + 1) % input.sampleEvery === 0) samples.push(await sample(page, cdp, index + 1))
  }
  // Settle, then sample again: anything released only on idle shows up here,
  // and anything that does not is genuinely retained.
  await page.waitForTimeout(4_000)
  samples.push(await sample(page, cdp, fixture.sessions.length))
  // Taken AFTER the settle and the final collection, so anything in it is
  // genuinely retained rather than merely uncollected.
  if (input.snapshotPath) await captureHeapSnapshot(cdp, input.snapshotPath)
  await context.close()

  const plateau = samples[samples.length - 1]!
  return {
    flow: "session-accumulation",
    samples,
    slopeBytesPerStep: tailSlope(samples),
    plateauBytes: plateau.heapBytes,
  }
}

/** Project a sweep onto the portable contract, so it compares like any other lane. */
export function memoryRecords(sweep: MemorySweep, stack: string, profile: string): PerfRecord[] {
  const heapSamples = sweep.samples.map((item) => item.heapBytes)
  return [
    {
      lane: "memory", flow: sweep.flow, metric: "retained_heap_bytes",
      value: sweep.plateauBytes, unit: METRICS.retained_heap_bytes!.unit,
      samples: heapSamples, stack, profile,
    },
  ]
}
