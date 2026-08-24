#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CDPSession } from "playwright"
import { measureSessionActivation } from "./agent-browser-observer"
import { armMessageResponseObservation, type MessageResponseObservation } from "./message-response-observer"
import {
  LANES,
  latencyCases,
  repoRoot,
  startRealWebHarness,
  type BenchmarkCase,
  type RendererPhase,
} from "./real-web-harness"
import {
  loadBuildAttributor,
  loadBuildOffsetResolver,
  normalizeSourcePath,
  type Attributor,
  type OffsetResolver,
} from "./source-map-attribution"
import { privacySafeResourceName } from "./privacy-safe-resource-name"

/**
 * Where a session switch spends its wall clock.
 *
 * The latency runner next door answers "how long"; this answers "on what", over
 * the identical real-load surface so the two are comparable observation for
 * observation. It samples V8 at 100us for exactly the click-to-stable-paint
 * window of every activation, then walks each frame back through the build's
 * sourcemaps to a repository path.
 *
 * It covers ALL FOUR lanes, not just the cold ones, because the question the
 * latency artifact cannot answer is where the non-JS remainder goes: a warm
 * switch completes in ~40 ms with under 5 ms of script, so naming the other
 * 35 ms needs the same window broken down by what the main thread was doing,
 * not another script total.
 *
 * Every window is therefore also split into idle / program / GC / JS, and the
 * idle share is correlated against the requests actually in flight during it.
 * That distinction is the whole point: idle that overlaps a pending fetch is
 * backend latency, and idle that does not is the renderer waiting on its own
 * frame cadence — the same number, two completely different fixes.
 *
 * Sampling at that rate inflates absolute time, so the artifact reports shares
 * of the profiled window rather than presenting sampled microseconds as if they
 * were the latency runner's milliseconds.
 */

/** Every lane, so warm switches are decomposed on the same terms as cold ones. */
const PROFILED_LANES = [
  "within-workspace-cold",
  "within-workspace-warm",
  "across-workspaces-cold",
  "across-workspaces-warm",
] as const

/**
 * A request observed inside an activation window.
 *
 * Only `startTime` and `duration` are trustworthy here. The app is served from
 * a different origin than the backend, so without `Timing-Allow-Origin` the
 * spec zeroes `requestStart`, `responseStart`, `transferSize` and
 * `decodedBodySize` — reading a TTFB out of them yields a confident 0 ms, which
 * is how "the idle is backend wait" can look measured when it is not.
 */
type WindowResource = {
  name: string
  startTime: number
  duration: number
}

type ProfileNode = {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }
  children?: number[]
}

type Profile = {
  nodes: ProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

type FrameCost = {
  key: string
  functionName: string
  source: string
  line: number
  snippet: string | undefined
  selfMicros: number
  totalMicros: number
  sampleCount: number
}

type CoverageEntry = {
  functionName: string
  source: string
  line: number
  calls: number
}

/**
 * Precise coverage costs real CPU inside the very window being measured, which
 * inflates busy time and therefore UNDERSTATES the idle share. It earns that
 * cost when the question is "what runs how often" and not when the question is
 * "how much of this switch was the thread parked", so it is opt-out.
 */
const collectCoverage = !process.argv.includes("--no-coverage")

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"))
const selectedCaseIds = new Set(process.argv
  .filter((value) => value.startsWith("--case-id="))
  .map((value) => value.slice("--case-id=".length)))
const outputDirectory = positional[0]
  ? path.resolve(positional[0])
  : path.join(repoRoot, ".context/compound-engineering/ce-optimize/cold-session-load/runs", `cold-profile-${Date.now()}`)

const actualSessionDatabasePath = process.env.CLAXEDO_ACTUAL_SESSION_DB?.trim() || undefined
const harness = await startRealWebHarness({
  outputDirectory,
  sourcemap: true,
  rendererTrace: true,
  actualSessionDatabasePath,
})

try {
  const { page, context, manifest, requireTarget, requireActivation } = harness
  const attributor = await loadBuildAttributor(harness.buildDirectory)
  const offsets = await loadBuildOffsetResolver(harness.buildDirectory)
  if (attributor.mappedChunkCount === 0) throw new Error("no sourcemaps emitted for the profiled build")
  const control = requireTarget("control")

  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  await cdp.send("Profiler.enable")
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 })
  const metrics = await cdp.send("Performance.getMetrics")
  const navigationStartSeconds = metrics.metrics.find((metric) => metric.name === "NavigationStart")?.value
  if (navigationStartSeconds === undefined) throw new Error("CDP did not expose NavigationStart")
  const profileDirectory = path.join(outputDirectory, "cpu-profiles")
  await mkdir(profileDirectory, { recursive: true })

  const switchCases = latencyCases(manifest.seed, LANES)
  const runs: Array<{
    case: BenchmarkCase
    durationMs: number
    profiledMicros: number
    rawProfiledMicros: number
    profilePath: string
    profileWindow: { startTime: number; endTime: number }
    frames: FrameCost[]
    phases: RendererPhase[]
    coverage: CoverageEntry[]
    surfaces: { mounted: number; hidden: number; sessionPages: number }
    paintStabilityFrames: Array<{
      atMs: number
      ready: boolean
      observerSampleMs: number
      signature?: Record<string, unknown>
      diagnostic?: Record<string, unknown>
    }>
    occupancy: Occupancy
    resources: WindowResource[]
    messageResponse: MessageResponseObservation
  }> = []

  for (const benchmarkCase of switchCases.filter((item) => selectedCaseIds.size === 0 || selectedCaseIds.has(item.caseId))) {
    const destination = requireTarget(benchmarkCase.destinationSessionId)
    if (benchmarkCase.sessionState === "warm") await requireActivation(destination, "warm-up")
    await requireActivation(control, "control")

    let profile: Profile | undefined
    let coverage: CoverageEntry[] = []
    const phaseCursor = await page.evaluate(() => window.__claxedoPerfRendererPhases?.length ?? 0)
    const finishMessageResponse = armMessageResponseObservation(page, destination.sessionId)
    const measured = await measureSessionActivation(page as never, destination, {
      onArmed: async () => {
        // Counts, not time. Precise coverage resets on start, so each activation
        // reports exactly the invocations its own click caused — the one thing a
        // 100us sampler cannot tell you about functions that run often and fast.
        if (collectCoverage) {
          await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
        }
        await cdp.send("Profiler.start")
      },
      onPainted: async () => {
        profile = (await stopProfiler(cdp)) as Profile
        if (collectCoverage) coverage = await takeInvocationCounts(cdp, attributor, offsets)
      },
    })
    if (measured.state !== "exact") throw new Error(`${benchmarkCase.caseId} failed: ${measured.reason}`)
    if (!profile) throw new Error(`${benchmarkCase.caseId} produced no cpu profile`)
    const messageResponse = await finishMessageResponse(benchmarkCase.sessionState === "cold")

    let phases = await page.evaluate(
      (from) => (window.__claxedoPerfRendererPhases ?? []).slice(from),
      phaseCursor,
    )
    if (harness.loadKind === "actual-session") {
      phases = phases.map((phase) => ({ ...phase, name: privacySafePhaseName(phase.name) }))
    }
    const resources = await page.evaluate(
      ({ from, to }) => performance
        .getEntriesByType("resource")
        .map((entry) => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration }))
        // Overlap, not containment: a request that began before the click and
        // was still pending during it is exactly the case that blocks a switch.
        .filter((entry) => entry.startTime + entry.duration >= from && entry.startTime <= to),
      { from: measured.trustedEventAtMs, to: measured.paintedAtMs },
    ) as WindowResource[]
    if (harness.loadKind === "actual-session") {
      for (const resource of resources) resource.name = privacySafeResourceName(resource.name)
    }
    const surfaces = await page.evaluate(() => {
      const slots = [...document.querySelectorAll<HTMLElement>("[data-workbench-content]")]
      return {
        mounted: slots.length,
        hidden: slots.filter((slot) => slot.getAttribute("aria-hidden") === "true" || slot.hasAttribute("inert")).length,
        sessionPages: document.querySelectorAll('[data-testid="session-page-root"]').length,
      }
    })
    const profileWindow = {
      startTime: navigationStartSeconds * 1_000_000 + measured.trustedEventAtMs * 1_000,
      endTime: navigationStartSeconds * 1_000_000 + measured.paintedAtMs * 1_000,
    }
    const analysis = analyzeProfile(profile, attributor, profileWindow)
    const occupancy = analyzeOccupancy(profile, profileWindow, navigationStartSeconds, resources)
    const absoluteProfilePath = path.join(profileDirectory, `${benchmarkCase.caseId}.cpuprofile`)
    await writeFile(absoluteProfilePath, `${JSON.stringify(profile)}\n`)
    const profilePath = path.relative(outputDirectory, absoluteProfilePath)
    runs.push({
      case: benchmarkCase,
      durationMs: measured.durationMs,
      profiledMicros: analysis.profiledMicros,
      rawProfiledMicros: analysis.rawProfiledMicros,
      profilePath,
      profileWindow,
      frames: analysis.frames,
      phases,
      coverage,
      surfaces,
      paintStabilityFrames: measured.paintStabilityFrames,
      occupancy,
      resources,
      messageResponse,
    })
  }
  await cdp.send("Profiler.disable")
  await cdp.send("Performance.disable")
  await cdp.detach()

  const artifact = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceCommit: harness.sourceCommit,
    surface: "production-local-web",
    samplingIntervalMicros: 100,
    preciseCoverage: collectCoverage,
    loadKind: harness.loadKind,
    activationCount: runs.length,
    note: "Shares are of the click-to-stable-paint window; 100us sampling inflates absolute time.",
    lanes: Object.fromEntries(
      PROFILED_LANES.map((lane) => {
        const selected = runs.filter((run) => run.case.id === lane)
        return [lane, {
          count: selected.length,
          durationMsMean: mean(selected.map((run) => run.durationMs)),
          profiledMicrosMean: mean(selected.map((run) => run.profiledMicros)),
          rawProfiledMicrosMean: mean(selected.map((run) => run.rawProfiledMicros)),
          occupancy: meanOccupancy(selected.map((run) => run.occupancy)),
          backendRequestsPerActivation:
            selected.reduce((sum, run) => sum + run.resources.length, 0) / selected.length,
        }]
      }),
    ),
    byPhase: rollupPhases(runs),
    byInvocation: rollupInvocations(runs).slice(0, 60),
    byInvocationByLane: Object.fromEntries(
      PROFILED_LANES.map((lane) => [
        lane,
        rollupInvocations(runs.filter((run) => run.case.id === lane)).slice(0, 60),
      ]),
    ),
    bySource: rollup(runs, (frame) => frame.source).slice(0, 40),
    byFunction: rollupFrames(runs).slice(0, 60),
    hotFunctionsByLane: Object.fromEntries(
      PROFILED_LANES.map((lane) => [
        lane,
        hotFunctionStats(runs.filter((run) => run.case.id === lane)),
      ]),
    ),
    perRun: runs.map((run) => ({
      caseId: run.case.caseId,
      lane: run.case.id,
      durationMs: run.durationMs,
      profiledMicros: run.profiledMicros,
      rawProfiledMicros: run.rawProfiledMicros,
      profilePath: run.profilePath,
      profileWindow: run.profileWindow,
      occupancy: run.occupancy,
      surfaces: run.surfaces,
      paintStabilityFrames: harness.loadKind === "actual-session"
        ? run.paintStabilityFrames.map((frame) => ({
            atMs: frame.atMs,
            ready: frame.ready,
            observerSampleMs: frame.observerSampleMs,
          }))
        : run.paintStabilityFrames,
      resources: run.resources,
      messageResponse: run.messageResponse,
      phases: run.phases,
      topInvocations: run.coverage.toSorted((left, right) => right.calls - left.calls).slice(0, 12),
      topFrames: run.frames.slice(0, 8).map((frame) => ({
        functionName: frame.functionName,
        source: frame.source,
        line: frame.line,
        selfMicros: frame.selfMicros,
      })),
    })),
  }

  const artifactPath = path.join(outputDirectory, "cold-profile.json")
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(artifactPath)
  console.log(renderReport(artifact))
} finally {
  await harness.close()
}

function privacySafePhaseName(value: string) {
  if (value.startsWith("timeline.mount.")) return "timeline.mount"
  return value
    .replace(/(?:ses|msg|prt)_actual_[A-Za-z0-9_-]+/gu, ":canonical-id")
    .replace(/workspace:%2F[^:]+/gu, "workspace::ephemeral")
}

/**
 * How the main thread spent an activation window, and why it was ever idle.
 *
 * V8 labels a sample `(idle)` when the isolate has no JS on the stack and the
 * thread is parked. That single bucket covers two unrelated situations, and the
 * split decides what to do about it:
 *
 *  - Idle that OVERLAPS a request still in flight is backend latency. The fix
 *    is on the server, or in not needing the round trip.
 *  - Idle that overlaps nothing is the renderer waiting on its own frame
 *    cadence — the gap between one presentation and the next rAF. No amount of
 *    backend work removes it.
 *
 * `longestIdleRunMicros` separates them again from the other side: one blocking
 * fetch shows up as a single long run, while frame-cadence waiting shows up as
 * many short ones no longer than a frame. A large idle total with a small
 * longest run is therefore proof that no single request was the cause.
 */
type Occupancy = {
  windowMicros: number
  idleMicros: number
  programMicros: number
  gcMicros: number
  scriptMicros: number
  /** Idle that overlapped at least one in-flight request. */
  networkBlockedIdleMicros: number
  /** Idle with nothing in flight — frame cadence and other self-inflicted waits. */
  unblockedIdleMicros: number
  /** Idle after the last non-idle sample: the confirmation-frame tail. */
  tailIdleMicros: number
  longestIdleRunMicros: number
  idleRunCount: number
}

function analyzeOccupancy(
  profile: Profile,
  window: { startTime: number; endTime: number },
  navigationStartSeconds: number,
  resources: readonly WindowResource[],
): Occupancy {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  // Profile timestamps share the CDP TimeTicks epoch; page `performance.now()`
  // is that epoch minus NavigationStart. Resource entries use the page clock,
  // so one of the two has to be converted before they can be intersected.
  const toPageMs = (micros: number) => (micros - navigationStartSeconds * 1_000_000) / 1000
  const inFlight = (pageMs: number) =>
    resources.some((entry) => pageMs >= entry.startTime && pageMs <= entry.startTime + entry.duration)

  const occupancy: Occupancy = {
    windowMicros: window.endTime - window.startTime,
    idleMicros: 0,
    programMicros: 0,
    gcMicros: 0,
    scriptMicros: 0,
    networkBlockedIdleMicros: 0,
    unblockedIdleMicros: 0,
    tailIdleMicros: 0,
    longestIdleRunMicros: 0,
    idleRunCount: 0,
  }

  let clock = profile.startTime
  let lastBusy = window.startTime
  let run = 0
  for (let index = 0; index < samples.length; index++) {
    clock += deltas[index] ?? 0
    if (clock < window.startTime || clock > window.endTime) continue
    const micros = Math.max(0, deltas[index] ?? 0)
    const name = byId.get(samples[index]!)?.callFrame.functionName
    if (name === "(idle)") {
      occupancy.idleMicros += micros
      if (inFlight(toPageMs(clock))) occupancy.networkBlockedIdleMicros += micros
      else occupancy.unblockedIdleMicros += micros
      if (run === 0) occupancy.idleRunCount += 1
      run += micros
      occupancy.longestIdleRunMicros = Math.max(occupancy.longestIdleRunMicros, run)
      continue
    }
    run = 0
    lastBusy = clock
    if (name === "(program)") occupancy.programMicros += micros
    else if (name === "(garbage collector)") occupancy.gcMicros += micros
    else occupancy.scriptMicros += micros
  }
  occupancy.tailIdleMicros = Math.max(0, window.endTime - lastBusy)
  return occupancy
}

function meanOccupancy(values: readonly Occupancy[]): Occupancy {
  const keys = Object.keys(values[0] ?? {}) as Array<keyof Occupancy>
  return Object.fromEntries(
    keys.map((key) => [key, values.reduce((sum, item) => sum + item[key], 0) / values.length]),
  ) as Occupancy
}

async function takeInvocationCounts(
  cdp: CDPSession,
  attributor: Attributor,
  offsets: OffsetResolver,
): Promise<CoverageEntry[]> {
  const taken = (await cdp.send("Profiler.takePreciseCoverage")) as {
    result: Array<{
      url: string
      functions: Array<{ functionName: string; ranges: Array<{ startOffset: number; count: number }> }>
    }>
  }
  await cdp.send("Profiler.stopPreciseCoverage")
  const entries: CoverageEntry[] = []
  for (const script of taken.result) {
    if (!script.url) continue
    for (const fn of script.functions) {
      // The first range is the function body itself; its count is the number of
      // invocations. Later ranges are per-block and would double count.
      const own = fn.ranges[0]
      if (!own || own.count === 0) continue
      const position = offsets.resolve(script.url, own.startOffset)
      if (!position) continue
      const original = attributor.attribute(script.url, position.line, position.column)
      if (!original) continue
      entries.push({
        functionName: fn.functionName || "(anonymous)",
        source: normalizeSourcePath(original.source),
        line: original.line,
        calls: own.count,
      })
    }
  }
  return entries
}

async function stopProfiler(cdp: CDPSession) {
  const stopped = (await cdp.send("Profiler.stop")) as { profile: Profile }
  return stopped.profile
}

function analyzeProfile(
  profile: Profile,
  attributor: Attributor,
  window: { startTime: number; endTime: number },
) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }

  const selfMicros = new Map<number, number>()
  const sampleCount = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  let profiledMicros = 0
  let rawProfiledMicros = 0
  let timestamp = profile.startTime
  for (let index = 0; index < samples.length; index++) {
    const id = samples[index]!
    const delta = Math.max(0, deltas[index] ?? 0)
    const previousTimestamp = timestamp
    timestamp += delta
    rawProfiledMicros += delta
    const overlap = Math.max(
      0,
      Math.min(timestamp, window.endTime) - Math.max(previousTimestamp, window.startTime),
    )
    if (overlap === 0) continue
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + overlap)
    sampleCount.set(id, (sampleCount.get(id) ?? 0) + 1)
    profiledMicros += overlap
  }

  // Total time folds each node's self time into every ancestor, so an entry
  // point reads as the cost of everything it caused rather than the sliver it
  // executed itself.
  const totalMicros = new Map<string, number>()
  const describe = (node: ProfileNode) => {
    const frame = node.callFrame
    const position = frame.url
      ? attributor.attribute(frame.url, frame.lineNumber, frame.columnNumber)
      : undefined
    const source = position ? normalizeSourcePath(position.source) : frame.url ? "(unmapped)" : "(vm)"
    const line = position?.line ?? frame.lineNumber + 1
    return {
      key: `${position?.name || frame.functionName || "(anonymous)"}@${source}:${line}`,
      functionName: position?.name || frame.functionName || "(anonymous)",
      source,
      line,
      snippet: position ? attributor.sourceLineText(position) : undefined,
    }
  }

  const described = new Map<number, ReturnType<typeof describe>>()
  for (const node of profile.nodes) described.set(node.id, describe(node))

  for (const [id, micros] of selfMicros) {
    const seen = new Set<string>()
    let cursor: number | undefined = id
    while (cursor !== undefined) {
      const key = described.get(cursor)?.key
      if (key && !seen.has(key)) {
        seen.add(key)
        totalMicros.set(key, (totalMicros.get(key) ?? 0) + micros)
      }
      cursor = parent.get(cursor)
    }
  }

  const merged = new Map<string, FrameCost>()
  for (const node of profile.nodes) {
    const info = described.get(node.id)!
    const self = selfMicros.get(node.id) ?? 0
    const count = sampleCount.get(node.id) ?? 0
    if (self === 0 && count === 0) continue
    const existing = merged.get(info.key)
    if (existing) {
      existing.selfMicros += self
      existing.sampleCount += count
      continue
    }
    merged.set(info.key, {
      ...info,
      selfMicros: self,
      totalMicros: 0,
      sampleCount: count,
    })
  }
  for (const frame of merged.values()) frame.totalMicros = totalMicros.get(frame.key) ?? frame.selfMicros

  return {
    profiledMicros,
    rawProfiledMicros,
    frames: [...merged.values()].toSorted((left, right) => right.selfMicros - left.selfMicros),
  }
}

function rollup(runs: Array<{ frames: FrameCost[] }>, key: (frame: FrameCost) => string) {
  const totals = new Map<string, { key: string; selfMicros: number; sampleCount: number }>()
  for (const run of runs) {
    for (const frame of run.frames) {
      const identity = key(frame)
      const entry = totals.get(identity) ?? { key: identity, selfMicros: 0, sampleCount: 0 }
      entry.selfMicros += frame.selfMicros
      entry.sampleCount += frame.sampleCount
      totals.set(identity, entry)
    }
  }
  const grand = [...totals.values()].reduce((sum, entry) => sum + entry.selfMicros, 0)
  return [...totals.values()]
    .toSorted((left, right) => right.selfMicros - left.selfMicros)
    .map((entry) => ({
      ...entry,
      selfMicrosPerActivation: entry.selfMicros / runs.length,
      shareOfProfiledWindow: grand === 0 ? 0 : entry.selfMicros / grand,
    }))
}

function rollupFrames(runs: Array<{ frames: FrameCost[] }>) {
  const totals = new Map<string, FrameCost>()
  for (const run of runs) {
    for (const frame of run.frames) {
      const existing = totals.get(frame.key)
      if (!existing) {
        totals.set(frame.key, { ...frame })
        continue
      }
      existing.selfMicros += frame.selfMicros
      existing.totalMicros += frame.totalMicros
      existing.sampleCount += frame.sampleCount
    }
  }
  const grand = [...totals.values()].reduce((sum, entry) => sum + entry.selfMicros, 0)
  return [...totals.values()]
    .toSorted((left, right) => right.selfMicros - left.selfMicros)
    .map((frame) => ({
      functionName: frame.functionName,
      source: frame.source,
      line: frame.line,
      snippet: frame.snippet,
      selfMicrosPerActivation: frame.selfMicros / runs.length,
      totalMicrosPerActivation: frame.totalMicros / runs.length,
      shareOfProfiledWindow: grand === 0 ? 0 : frame.selfMicros / grand,
    }))
}

function hotFunctionStats(runs: Array<{ frames: FrameCost[] }>) {
  const identities = new Map<string, FrameCost>()
  for (const run of runs) {
    for (const frame of run.frames) identities.set(frame.key, frame)
  }
  return [...identities.entries()]
    .map(([key, identity]) => {
      const self = runs.map((run) => run.frames.find((frame) => frame.key === key)?.selfMicros ?? 0)
      const total = runs.map((run) => run.frames.find((frame) => frame.key === key)?.totalMicros ?? 0)
      const present = self.filter((value) => value > 0).length
      return {
        functionName: identity.functionName,
        source: identity.source,
        line: identity.line,
        snippet: identity.snippet,
        presentIn: present,
        selfMicros: distribution(self),
        inclusiveMicros: distribution(total),
      }
    })
    .filter((entry) =>
      entry.selfMicros.mean >= 1_000 ||
      entry.selfMicros.p95 >= 1_000 ||
      entry.selfMicros.max >= 4_000 ||
      entry.inclusiveMicros.p95 >= 2_000,
    )
    .toSorted((left, right) => right.selfMicros.mean - left.selfMicros.mean)
}

function distribution(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right)
  return {
    mean: mean(sorted),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  }
}

function percentile(values: number[], quantile: number) {
  if (values.length === 0) return Number.NaN
  const index = (values.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return values[lower]!
  return values[lower]! + (values[upper]! - values[lower]!) * (index - lower)
}

/**
 * Mean duration and per-activation call count of each named app phase.
 *
 * Counts matter as much as durations here: a phase that runs three times per
 * open is a different problem from one slow phase, and the mean alone hides it.
 */
function rollupPhases(runs: Array<{ phases: RendererPhase[] }>) {
  const totals = new Map<string, { name: string; totalMs: number; calls: number }>()
  for (const run of runs) {
    for (const phase of run.phases) {
      const entry = totals.get(phase.name) ?? { name: phase.name, totalMs: 0, calls: 0 }
      entry.totalMs += phase.durationMs
      entry.calls += 1
      totals.set(phase.name, entry)
    }
  }
  return [...totals.values()]
    .toSorted((left, right) => right.totalMs - left.totalMs)
    .map((entry) => ({
      name: entry.name,
      msPerActivation: entry.totalMs / runs.length,
      callsPerActivation: entry.calls / runs.length,
    }))
}

/**
 * Mean per-activation invocation count of every function that ran.
 *
 * Ranked by calls rather than time on purpose: the expensive shape in a
 * reactive app is a cheap function invoked far more often than the change
 * warranted, and that is invisible in a time-ranked profile.
 */
function rollupInvocations(runs: Array<{ coverage: CoverageEntry[] }>) {
  const totals = new Map<string, CoverageEntry>()
  for (const run of runs) {
    for (const entry of run.coverage) {
      const key = `${entry.functionName}@${entry.source}:${entry.line}`
      const existing = totals.get(key)
      if (!existing) {
        totals.set(key, { ...entry })
        continue
      }
      existing.calls += entry.calls
    }
  }
  return [...totals.values()]
    .toSorted((left, right) => right.calls - left.calls)
    .map((entry) => ({
      functionName: entry.functionName,
      source: entry.source,
      line: entry.line,
      callsPerActivation: entry.calls / runs.length,
    }))
}

function mean(values: number[]) {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length
}

function renderReport(artifact: {
  lanes: Record<string, { occupancy: Occupancy; backendRequestsPerActivation: number }>
  byInvocation: Array<{ functionName: string; source: string; line: number; callsPerActivation: number }>
  byInvocationByLane: Record<
    string,
    Array<{ functionName: string; source: string; line: number; callsPerActivation: number }>
  >
  byPhase: Array<{ name: string; msPerActivation: number; callsPerActivation: number }>
  bySource: Array<{ key: string; selfMicrosPerActivation: number; shareOfProfiledWindow: number }>
  byFunction: Array<{
    functionName: string
    source: string
    line: number
    selfMicrosPerActivation: number
    totalMicrosPerActivation: number
  }>
}) {
  const lines = ["", "main-thread occupancy per activation (sampled window)"]
  lines.push(
    `  ${"lane".padEnd(24)} ${"window".padStart(9)} ${"script".padStart(9)} ${"program".padStart(9)} ${"gc".padStart(7)} ${"idle".padStart(9)} ${"net-idle".padStart(9)} ${"free-idle".padStart(10)} ${"tail".padStart(7)} ${"maxRun".padStart(8)} ${"runs".padStart(5)} ${"reqs".padStart(5)}`,
  )
  for (const [lane, value] of Object.entries(artifact.lanes)) {
    const o = value.occupancy
    if (o.idleRunCount === undefined) continue
    const ms = (micros: number) => (micros / 1000).toFixed(1)
    lines.push(
      `  ${lane.padEnd(24)} ${ms(o.windowMicros).padStart(8)}ms ${ms(o.scriptMicros).padStart(8)}ms ${ms(o.programMicros).padStart(8)}ms ${ms(o.gcMicros).padStart(6)}ms ${ms(o.idleMicros).padStart(8)}ms ${ms(o.networkBlockedIdleMicros).padStart(8)}ms ${ms(o.unblockedIdleMicros).padStart(9)}ms ${ms(o.tailIdleMicros).padStart(6)}ms ${ms(o.longestIdleRunMicros).padStart(7)}ms ${o.idleRunCount.toFixed(1).padStart(5)} ${value.backendRequestsPerActivation.toFixed(1).padStart(5)}`,
    )
  }
  lines.push("", "app phase time (per activation, unsampled)")
  for (const entry of artifact.byPhase) {
    lines.push(
      `  ${entry.msPerActivation.toFixed(2).padStart(8)} ms  x${entry.callsPerActivation.toFixed(1)}  ${entry.name}`,
    )
  }
  for (const [lane, entries] of Object.entries(artifact.byInvocationByLane)) {
    lines.push("", `app-code invocations (${lane}, per activation)`)
    for (const entry of entries.filter((item) => item.source.startsWith("packages/")).slice(0, 20)) {
      lines.push(
        `  ${entry.callsPerActivation.toFixed(1).padStart(9)} x  ${entry.functionName}  ${entry.source}:${entry.line}`,
      )
    }
  }
  lines.push("", "self time by source (per cold activation)")
  for (const entry of artifact.bySource.slice(0, 20)) {
    lines.push(
      `  ${(entry.selfMicrosPerActivation / 1000).toFixed(2).padStart(8)} ms  ${(entry.shareOfProfiledWindow * 100).toFixed(1).padStart(5)}%  ${entry.key}`,
    )
  }
  lines.push("", "self time by function (per cold activation)")
  for (const entry of artifact.byFunction.slice(0, 30)) {
    lines.push(
      `  ${(entry.selfMicrosPerActivation / 1000).toFixed(2).padStart(8)} ms  (total ${(entry.totalMicrosPerActivation / 1000).toFixed(2).padStart(8)} ms)  ${entry.functionName}  ${entry.source}:${entry.line}`,
    )
  }
  return lines.join("\n")
}
