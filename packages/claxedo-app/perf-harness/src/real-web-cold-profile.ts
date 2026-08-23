#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CDPSession } from "playwright"
import { measureSessionActivation } from "./agent-browser-observer"
import {
  LANES,
  latencyCases,
  repoRoot,
  startRealWebHarness,
  type BenchmarkCase,
  type RendererPhase,
} from "./real-web-harness"
import { loadBuildAttributor, normalizeSourcePath, type Attributor } from "./source-map-attribution"

/**
 * Where a cold session switch spends its JavaScript.
 *
 * The latency runner next door answers "how long"; this answers "on what", over
 * the identical real-load surface so the two are comparable observation for
 * observation. It samples V8 at 100us for exactly the click-to-stable-paint
 * window of every cold activation, then walks each frame back through the
 * build's sourcemaps to a repository path.
 *
 * Sampling at that rate inflates absolute time, so the artifact reports shares
 * of the profiled window rather than presenting sampled microseconds as if they
 * were the latency runner's milliseconds.
 */

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

const outputDirectory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, ".context/compound-engineering/ce-optimize/cold-session-load/runs", `cold-profile-${Date.now()}`)

const harness = await startRealWebHarness({ outputDirectory, sourcemap: true, rendererTrace: true })

try {
  const { page, context, manifest, requireTarget, requireActivation } = harness
  const attributor = await loadBuildAttributor(harness.buildDirectory)
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

  const coldCases = latencyCases(
    manifest.seed,
    LANES.filter((lane) => lane.sessionState === "cold"),
  )
  const runs: Array<{
    case: BenchmarkCase
    durationMs: number
    profiledMicros: number
    rawProfiledMicros: number
    profilePath: string
    profileWindow: { startTime: number; endTime: number }
    frames: FrameCost[]
    phases: RendererPhase[]
  }> = []

  for (const benchmarkCase of coldCases) {
    const destination = requireTarget(benchmarkCase.destinationSessionId)
    await requireActivation(control, "control")

    let profile: Profile | undefined
    const phaseCursor = await page.evaluate(() => window.__claxedoPerfRendererPhases?.length ?? 0)
    const measured = await measureSessionActivation(page as never, destination, {
      onArmed: async () => {
        await cdp.send("Profiler.start")
      },
      onPainted: async () => {
        profile = (await stopProfiler(cdp)) as Profile
      },
    })
    if (measured.state !== "exact") throw new Error(`${benchmarkCase.caseId} failed: ${measured.reason}`)
    if (!profile) throw new Error(`${benchmarkCase.caseId} produced no cpu profile`)

    const phases = await page.evaluate(
      (from) => (window.__claxedoPerfRendererPhases ?? []).slice(from),
      phaseCursor,
    )
    const profileWindow = {
      startTime: navigationStartSeconds * 1_000_000 + measured.trustedEventAtMs * 1_000,
      endTime: navigationStartSeconds * 1_000_000 + measured.paintedAtMs * 1_000,
    }
    const analysis = analyzeProfile(profile, attributor, profileWindow)
    const profilePath = path.join(profileDirectory, `${benchmarkCase.caseId}.cpuprofile`)
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`)
    runs.push({
      case: benchmarkCase,
      durationMs: measured.durationMs,
      profiledMicros: analysis.profiledMicros,
      rawProfiledMicros: analysis.rawProfiledMicros,
      profilePath,
      profileWindow,
      frames: analysis.frames,
      phases,
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
    activationCount: runs.length,
    note: "Shares are of the click-to-stable-paint window; 100us sampling inflates absolute time.",
    lanes: Object.fromEntries(
      ["within-workspace-cold", "across-workspaces-cold"].map((lane) => {
        const selected = runs.filter((run) => run.case.id === lane)
        return [lane, {
          count: selected.length,
          durationMsMean: mean(selected.map((run) => run.durationMs)),
          profiledMicrosMean: mean(selected.map((run) => run.profiledMicros)),
          rawProfiledMicrosMean: mean(selected.map((run) => run.rawProfiledMicros)),
        }]
      }),
    ),
    byPhase: rollupPhases(runs),
    bySource: rollup(runs, (frame) => frame.source).slice(0, 40),
    byFunction: rollupFrames(runs).slice(0, 60),
    hotFunctionsByLane: Object.fromEntries(
      ["within-workspace-cold", "across-workspaces-cold"].map((lane) => [
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

function mean(values: number[]) {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length
}

function renderReport(artifact: {
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
  const lines = ["", "app phase time (per cold activation, unsampled)"]
  for (const entry of artifact.byPhase) {
    lines.push(
      `  ${entry.msPerActivation.toFixed(2).padStart(8)} ms  x${entry.callsPerActivation.toFixed(1)}  ${entry.name}`,
    )
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
