import { chromium } from "playwright-core"
import { startApp, stopApp } from "./browser-runner"
import { environmentProfile } from "./environment-profile"
import {
  memoryRecords,
  memoryComparisonPublishable,
  MEMORY_CACHE_SETTLE_MINIMUM_MS,
  memoryRunValidity,
  parseMemoryInteger,
  PRODUCT_SESSION_CACHE_LIMIT,
  runMemorySweep,
  summarizeMemorySweeps,
  type MemorySweep,
  type MemorySweepMode,
} from "./memory-runner"
import { analyzeDetachedRetainers, countDetached, type RetainerGroup } from "./heap-snapshot"
import { appendRunLog, runLogEntry } from "./run-log"
import { compareToBaseline, readBaselineFor, writeBaselineFor } from "./baseline-store"
import { stackLabel } from "./stacks"
import path from "node:path"
import { reportsRoot, writeJson } from "./storage"
import { authoritativeSourceIdentity, captureMemoryProvenance, memoryProvenanceStable } from "./memory-provenance"

const MB = 1024 * 1024
const MEMORY_BROWSER_CLOSE_TIMEOUT_MS = 5_000

type BrowserClosureState = {
  connected: boolean | undefined
  contexts: number | undefined
}

type MemoryBrowserHandle = {
  close: () => Promise<void>
  contexts: () => readonly unknown[]
  isConnected: () => boolean
}

export type MemoryBrowserTeardown = {
  status: "closed" | "rejected" | "timed-out"
  timeoutMs: number
  before: BrowserClosureState
  after: BrowserClosureState
  verifiedClosed: boolean
  error?: string
}

function browserClosureState(browser: Pick<MemoryBrowserHandle, "contexts" | "isConnected">): BrowserClosureState {
  let connected: boolean | undefined
  let contexts: number | undefined
  try {
    connected = browser.isConnected()
  } catch {
    // Preserve unknown rather than claiming a browser process is gone.
  }
  try {
    contexts = browser.contexts().length
  } catch {
    // Some browser transports stop answering once the process exits.
  }
  return { connected, contexts }
}

/**
 * Bound Playwright teardown without weakening fresh-browser isolation.
 *
 * Chromium can exit while Playwright's `browser.close()` promise never
 * settles. The next repetition must not wait forever, but a failed close is
 * only safe when the public connection and context state both prove that the
 * browser is already gone.
 */
export async function closeMemoryBrowser(
  browser: MemoryBrowserHandle,
  timeoutMs = MEMORY_BROWSER_CLOSE_TIMEOUT_MS,
): Promise<MemoryBrowserTeardown> {
  const before = browserClosureState(browser)
  const close = Promise.resolve()
    .then(() => browser.close())
    .then(
      () => ({ status: "closed" as const }),
      (error) => ({
        status: "rejected" as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  const settled = await new Promise<Awaited<typeof close> | { status: "timed-out" }>((resolve) => {
    const timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs)
    void close.then((result) => {
      clearTimeout(timer)
      resolve(result)
    })
  })
  const after = browserClosureState(browser)
  return {
    ...settled,
    timeoutMs,
    before,
    after,
    verifiedClosed: after.connected === false && after.contexts === 0,
  }
}

/**
 * Parse the snapshot off the main path and tolerate failure.
 *
 * A snapshot of this app runs to hundreds of MB; parsing can exhaust memory on
 * a small container. The sweep's own numbers are the deliverable, so a failed
 * analysis degrades to "no retainer table" rather than losing the run.
 */
type SnapshotAnalysis =
  | { status: "captured"; detachedNodes: number; retainers: RetainerGroup[] }
  | { status: "unavailable"; error: string; retainers: [] }

async function readRetainers(file: string): Promise<SnapshotAnalysis> {
  try {
    const raw = await Bun.file(file).json()
    const detachedNodes = countDetached(raw)
    if (detachedNodes === undefined) {
      return { status: "unavailable", error: "heap snapshot schema has no detachedness field", retainers: [] }
    }
    console.log(`[perf] heap snapshot: ${detachedNodes} V8-detached nodes`)
    return { status: "captured", detachedNodes, retainers: analyzeDetachedRetainers(raw) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[perf] heap snapshot analysis skipped: ${message}`)
    return { status: "unavailable", error: message, retainers: [] }
  }
}

/** First vs last entry count per query-key family, worst growth first. */
function familyRows(sweep: { samples: Array<{ families: Record<string, number> }> }) {
  const first = sweep.samples[0]?.families ?? {}
  const last = sweep.samples.at(-1)?.families ?? {}
  return Object.keys({ ...first, ...last })
    .map((family) => ({ family, from: first[family] ?? 0, to: last[family] ?? 0 }))
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))
    .map((row) => `| ${row.family} | ${row.from} | ${row.to} | ${row.to - row.from >= 0 ? "+" : ""}${row.to - row.from} |`)
}

/**
 * Drive the memory lane and render its verdict.
 *
 * The verdict is about SHAPE, not size. "How much memory does it use" has no
 * useful answer — it depends on what the user did — whereas "does repeating the
 * same action forever cost anything" is answerable and is what a ceiling
 * promises. So the number that matters is the tail slope, and the plateau is
 * reported next to it as context rather than as the result.
 */
export async function runMemoryLane(options: {
  profile: string
  stack: string
  sessions: number
  accept_baseline: boolean
  headless: boolean
  snapshot: boolean
  iterations?: number
  mode?: MemorySweepMode
  normalDwellMs?: number
  rapidDwellMs?: number
  cacheCeiling?: number
  settleMinimumMs?: number
  settleTimeoutMs?: number
}) {
  const profile = environmentProfile(options.profile)
  const app = await startApp()
  try {
    const snapshotPath = options.snapshot ? path.join(reportsRoot, "heap.heapsnapshot") : undefined
    const iterations = parseMemoryInteger("iterations", options.iterations ?? 1, 1)
    const sweeps: MemorySweep[] = []
    const browserTeardowns: Array<MemoryBrowserTeardown & { iteration: number }> = []
    let startProvenance: Awaited<ReturnType<typeof captureMemoryProvenance>> | undefined
    let browserVersion = "unknown"
    for (let index = 0; index < iterations; index++) {
      const browser = await chromium.launch({
        headless: options.headless,
        timeout: 30_000,
        args: ["--js-flags=--expose-gc"],
      })
      browserVersion = browser.version()
      try {
        startProvenance ??= await captureMemoryProvenance({ browserVersion, appCommand: app.command })
        sweeps.push(await runMemorySweep({
          browser,
          app,
          profile,
          sessions: options.sessions,
          sampleEvery: 10,
          mode: options.mode,
          normalDwellMs: options.normalDwellMs,
          rapidDwellMs: options.rapidDwellMs,
          cacheCeiling: options.cacheCeiling,
          settleMinimumMs: options.settleMinimumMs,
          settleTimeoutMs: options.settleTimeoutMs,
          snapshotPath: index === iterations - 1 ? snapshotPath : undefined,
        }))
      } finally {
        const teardown = await closeMemoryBrowser(browser)
        browserTeardowns.push({ iteration: index + 1, ...teardown })
        if (teardown.status !== "closed" || !teardown.verifiedClosed) {
          console.warn(
            `[perf] browser teardown ${teardown.status} after repetition ${index + 1}; ` +
            `verifiedClosed=${teardown.verifiedClosed}` +
            (teardown.error ? `; ${teardown.error}` : ""),
          )
        }
        if (!teardown.verifiedClosed) {
          throw new Error(`Memory repetition ${index + 1} browser cleanup could not be verified`)
        }
      }
    }
    const summary = summarizeMemorySweeps(sweeps)
    const snapshot: SnapshotAnalysis | undefined = snapshotPath ? await readRetainers(snapshotPath) : undefined
    const endProvenance = await captureMemoryProvenance({ browserVersion, appCommand: app.command })
    const provenance = {
      start: startProvenance!,
      end: endProvenance,
      sourceStable: memoryProvenanceStable(startProvenance!, endProvenance),
    }
    const sourceIdentity = authoritativeSourceIdentity(startProvenance!)
    const repetitionsSufficient = iterations >= 5
    const snapshotAvailable = !snapshotPath || snapshot?.status === "captured"
    const measuredValidity = memoryRunValidity({
      summary,
      repetitionsSufficient,
      sourceStable: provenance.sourceStable,
      snapshotAvailable,
    })
    const browserCleanupVerified = browserTeardowns.every((item) => item.verifiedClosed)
    const validity = browserCleanupVerified
      ? measuredValidity
      : {
        status: "invalid" as const,
        reasons: [...measuredValidity.reasons, "browser-cleanup-unverified"],
      }
    const valid = memoryComparisonPublishable(validity)
    const records = memoryRecords(summary, options.stack, profile.id)
    const baseline = valid
      ? await readBaselineFor({ profile: profile.id, stack: options.stack, lane: "memory", flow: summary.flow })
      : undefined
    const comparison = valid ? compareToBaseline(records, baseline) : []
    // Persist the sweep. The family table is the actionable part and it is the
    // last thing printed, so it is exactly what gets lost to a truncated
    // terminal — and re-running to see it costs another full sweep.
    await writeJson(path.join(reportsRoot, "memory-sweep.json"), {
      schemaVersion: 2,
      flow: summary.flow,
      mode: summary.mode,
      stack: options.stack,
      profile: profile.id,
      sessions: options.sessions,
      iterations,
      valid,
      validity,
      repetitionsSufficient,
      durableComparisonPublished: valid,
      provenance,
      contract: {
        navigation: "trusted-click-canonical-rail-session-activate",
        heap: "CDP Runtime.getHeapUsage.usedSize after HeapProfiler.collectGarbage",
        slope: "least-squares regression over final two-thirds of visit samples",
        settlement: `three stable forced-GC samples after >=${Math.max(MEMORY_CACHE_SETTLE_MINIMUM_MS, options.settleMinimumMs ?? 0)}ms cache-idle allowance`,
        productCacheCeiling: PRODUCT_SESSION_CACHE_LIMIT,
        diagnosticCacheCeiling: options.cacheCeiling ?? PRODUCT_SESSION_CACHE_LIMIT,
      },
      slopeBytesPerStep: summary.slopeBytesPerStep,
      slopeMinBytesPerStep: summary.slopeMinBytesPerStep,
      slopeMaxBytesPerStep: summary.slopeMaxBytesPerStep,
      plateauBytes: summary.plateauBytes,
      allSettled: summary.allSettled,
      cacheCeilingSatisfied: summary.cacheCeilingSatisfied,
      browserCleanupVerified,
      browserTeardowns,
      snapshot: snapshotPath
        ? snapshot?.status === "captured"
          ? { status: snapshot.status, path: snapshotPath, v8DetachedNodes: snapshot.detachedNodes }
          : { status: "unavailable", path: snapshotPath, error: snapshot?.error ?? "snapshot analysis missing" }
        : undefined,
      sweeps,
    })
    if (options.accept_baseline) {
      if (!valid) throw new Error(`Refusing to accept invalid memory baseline: ${validity.reasons.join(", ")}`)
      await writeBaselineFor(records, sourceIdentity.mode === "git" ? sourceIdentity.commit : undefined, sourceIdentity)
    }

    const sweep = sweeps.at(-1)!
    const lastObserved = sweep.settlement.samples.at(-1) ?? sweep.samples.at(-1)!
    const firstFamilies = sweep.samples[0]?.families ?? {}
    const lastFamilies = lastObserved.families
    const entry = valid ? runLogEntry({
      records,
      comparison,
      commit: sourceIdentity.mode === "git" ? sourceIdentity.commit : undefined,
      sourceIdentity,
      at: new Date().toISOString(),
      // The snapshot and the full sample series are far too large to track;
      // these three lines are the finding they produced.
      evidence: {
        sessions: options.sessions,
        iterations,
        slopeBytesPerStep: Math.round(summary.slopeBytesPerStep!),
        slopeRangeBytesPerStep: [Math.round(summary.slopeMinBytesPerStep!), Math.round(summary.slopeMaxBytesPerStep!)],
        ...(snapshot?.status === "captured" ? { v8DetachedNodes: snapshot.detachedNodes } : {}),
        listenerGrowth: lastObserved.liveListeners - sweep.samples[0]!.liveListeners,
        cacheCeilingSatisfied: summary.cacheCeilingSatisfied,
        settled: summary.allSettled,
        sourceStable: provenance.sourceStable,
        browserTeardowns,
        familyGrowth: Object.fromEntries(
          Object.keys({ ...firstFamilies, ...lastFamilies })
            .map((family) => [family, (lastFamilies[family] ?? 0) - (firstFamilies[family] ?? 0)])
            .filter(([, delta]) => (delta as number) !== 0)
            .sort((a, b) => (b[1] as number) - (a[1] as number))
            .slice(0, 8),
        ),
        ...(snapshot?.retainers.length ? { topRetainers: snapshot.retainers.slice(0, 5) } : {}),
      },
    }) : undefined
    if (entry) await appendRunLog(entry)

    const observedSamples = [...sweep.samples, ...sweep.settlement.samples]
    const rows = observedSamples.map((item) =>
      `| ${item.step} | ${(item.heapBytes / MB).toFixed(1)} | ${item.documentElements} | ${item.liveDomNodes} | ` +
      `${item.liveListeners} | ${item.queries} | ${item.cachedSessions} | ${item.lightweightSessions} |`)
    const firstSample = sweep.samples[0]!
    const listenerGrowth = lastObserved.liveListeners - firstSample.liveListeners
    // Did the sweep actually exercise the app? The false pass this lane exists
    // to avoid looks like every counter frozen at its boot value.
    //
    // Judged on PEAK query count, not on `cachedSessions` first-vs-last: that
    // counter is deliberately bounded, so a working ceiling drives it back DOWN
    // by the end of a sweep. Reading its fall as "nothing accumulated" fired
    // this caveat on a run whose query cache had grown from 173 to 388.
    const peakQueries = Math.max(...observedSamples.map((item) => item.queries))
    const accumulated = peakQueries > firstSample.queries
    const iterationRows = sweeps.map((item, index) =>
      `| ${index + 1} | ${item.slopeBytesPerStep === undefined ? "unsupported" : (item.slopeBytesPerStep / 1024).toFixed(1)} | ` +
      `${(item.plateauBytes / MB).toFixed(1)} | ${item.settlement.stable ? "yes" : "no"} | ` +
      `${item.settlement.cacheCeilingSatisfied ? "yes" : "no"} | ${item.settlement.diagnosticCacheCeilingSatisfied ? "yes" : "no"} |`)
    const headlineSlope = summary.slopeBytesPerStep === undefined
      ? "unsupported"
      : `${(summary.slopeBytesPerStep / 1024).toFixed(1)} kB per visit`
    const slopeRange = summary.slopeMinBytesPerStep === undefined || summary.slopeMaxBytesPerStep === undefined
      ? "unsupported"
      : `${(summary.slopeMinBytesPerStep / 1024).toFixed(1)}–${(summary.slopeMaxBytesPerStep / 1024).toFixed(1)} kB/visit`
    return [
      `# Memory lane — ${summary.flow}`,
      "",
      `Stack: ${stackLabel(options.stack)}  ·  Machine: ${profile.label}  ·  ${options.sessions} trusted session clicks × ${iterations}`,
      "",
      "Verdict is the median least-squares tail slope of forced-GC V8 JavaScript heap across fresh-browser repetitions.",
      "Native DOM, renderer RSS, GPU, and image memory are not included in this JS-heap number.",
      "",
      `**Tail slope: ${headlineSlope}** ` +
        `(range ${slopeRange}) ` +
        `· settled heap median ${(summary.plateauBytes / MB).toFixed(1)} MB`,
      "",
      valid ? "**Validity: valid.**" : "**Validity: invalid — do not accept as a regression result.**",
      !provenance.sourceStable ? "> Source or served build changed during the repetitions." : "",
      !summary.slopeSupported ? "> Too few distinct post-click tail samples to fit a slope." : "",
      !repetitionsSufficient ? "> Fewer than 5 fresh-browser repetitions; the slope and spread are provisional." : "",
      !summary.allSettled ? "> Final forced-GC samples did not stabilize." : "",
      !summary.cacheCeilingSatisfied ? `> Product cache ceiling failed: final cachedSessions exceeded ${PRODUCT_SESSION_CACHE_LIMIT}.` : "",
      !browserCleanupVerified ? "> At least one browser teardown could not be verified; this run is not comparable." : "",
      browserTeardowns.some((item) => item.status !== "closed") && browserCleanupVerified
        ? "> Playwright teardown reported an anomaly, but the browser connection and all contexts were verified closed."
        : "",
      snapshotPath && snapshot?.status !== "captured" ? "> Requested V8 heap snapshot could not be analyzed." : "",
      "",
      "| repetition | JS heap slope (kB/visit) | settled heap (MB) | stable | product ceiling 40 | diagnostic ceiling |",
      "| ---: | ---: | ---: | --- | --- | --- |",
      ...iterationRows,
      "",
      accumulated
        ? ""
        : "> Caveat: `cachedSessions` never rose, so this sweep did not accumulate per-session state. Read the slope as unproven, not as a plateau.",
      "",
      snapshot?.status === "captured"
        ? `**Final V8 snapshot: ${snapshot.detachedNodes} nodes marked detached; live listeners changed by ${listenerGrowth}.**`
        : snapshotPath
          ? `Live listeners changed by ${listenerGrowth}; requested heap snapshot analysis was unavailable.`
          : `Live listeners changed by ${listenerGrowth}; no heap snapshot was requested, so detached DOM is unmeasured.`,
      "",
      "| visit | JS heap (MB) | main-document elements | all live DOM nodes | live listeners | queries | cachedSessions | lightweightSessions |",
      "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows,
      "",
      "Query-cache entries by key family, first sample vs last — growth here names the structure:",
      "",
      "| family | first | last | delta |",
      "| --- | ---: | ---: | ---: |",
      ...familyRows({ samples: [{ families: firstFamilies }, { families: lastFamilies }] }),
      "",
      ...(snapshot?.retainers.length
        ? [
          "",
          "What still points at the detached DOM (attached retainer, by edge):",
          "",
          "| retainer | edge | detached nodes | bytes |",
          "| --- | --- | ---: | ---: |",
          ...snapshot.retainers.map((item) =>
            `| ${item.retainer} | ${item.edge} | ${item.detachedNodes} | ${(item.bytes / 1024).toFixed(0)} kB |`),
        ]
        : []),
      "",
      ...(valid
        ? [
          "| Metric | Baseline | Current | Verdict |",
          "| --- | ---: | ---: | --- |",
          ...comparison.map((item) =>
            `| ${item.metric} | ${item.baseline === undefined ? "—" : item.metric === "retained_heap_bytes_per_visit" ? (item.baseline / 1024).toFixed(1) + " kB/visit" : (item.baseline / MB).toFixed(1) + " MB"} | ` +
            `${item.current === undefined ? "absent" : item.metric === "retained_heap_bytes_per_visit" ? (item.current / 1024).toFixed(1) + " kB/visit" : (item.current / MB).toFixed(1) + " MB"} | ${item.verdict} |`),
        ]
        : ["No baseline comparison or durable run-log verdict was published for this invalid run."]),
    ].join("\n")
  } finally {
    await stopApp(app).catch(() => undefined)
  }
}
