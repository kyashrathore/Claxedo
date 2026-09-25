export type Metrics = Record<string, number>

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }
export type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }

type LoafScript = {
  duration: number
  forcedStyleAndLayoutDuration: number
  invoker: string
  invokerType: string
  sourceURL: string
  sourceFunctionName: string
  sourceCharPosition: number
}

export type Probe = {
  startedAt: number
  stoppedAt: number
  arrivals: number
  latencies: number[]
  frames: number[]
  gaps: number[]
  loafs: { duration: number; blockingDuration: number; scripts: LoafScript[] }[]
}

export type Heap = { before: number; after: number; nodes: number }

const FRAME_BUDGET_MS = 1000 / 60

export function selfTime(profile: Profile) {
  const byNode = new Map<number, number>()
  profile.samples.forEach((node, index) => byNode.set(node, (byNode.get(node) ?? 0) + (profile.timeDeltas[index] ?? 0)))
  const byFrame = new Map<string, number>()
  for (const node of profile.nodes) {
    const us = byNode.get(node.id) ?? 0
    if (!us) continue
    const frame = node.callFrame
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").at(-1) ?? ""}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    byFrame.set(key, (byFrame.get(key) ?? 0) + us)
  }
  return [...byFrame.entries()].sort((a, b) => b[1] - a[1]).map(([frame, us]) => ({ frame, ms: round(us / 1000) }))
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
}

function round(value: number) {
  return +value.toFixed(1)
}

function frameStats(frames: number[]) {
  return {
    total: frames.length,
    over16_7: frames.filter((interval) => interval > FRAME_BUDGET_MS * 1.25).length,
    over33: frames.filter((interval) => interval > 33.4).length,
    over50: frames.filter((interval) => interval > 50).length,
    dropped: frames.reduce((sum, interval) => sum + Math.max(0, Math.round(interval / FRAME_BUDGET_MS) - 1), 0),
    p99Interval: round(quantile(frames, 0.99)),
    maxInterval: round(Math.max(0, ...frames)),
  }
}

export function loafScripts(probe: Probe) {
  const byScript = new Map<string, { ms: number; forced: number; count: number }>()
  for (const loaf of probe.loafs)
    for (const script of loaf.scripts) {
      const key = `${script.invokerType} ${script.invoker} ${script.sourceFunctionName} ${script.sourceURL.split("/").at(-1)}:${script.sourceCharPosition}`
      const current = byScript.get(key) ?? { ms: 0, forced: 0, count: 0 }
      current.ms += script.duration
      current.forced += script.forcedStyleAndLayoutDuration
      current.count += 1
      byScript.set(key, current)
    }
  return [...byScript.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 15)
    .map(([key, value]) => ({ key, ms: round(value.ms), forced: round(value.forced), count: value.count }))
}

export function summarize(input: { probe: Probe; before: Metrics; after: Metrics; profile: Profile; heap: Heap }) {
  const { probe, before, after, heap } = input
  const wallS = (probe.stoppedAt - probe.startedAt) / 1000
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0)
  const self = selfTime(input.profile)
  const gcMs = self.filter((entry) => entry.frame.startsWith("(garbage collector)")).reduce((sum, entry) => sum + entry.ms, 0)
  return {
    wallS: round(wallS),
    deltaArrivals: probe.arrivals,
    deltaPaint: {
      p50: round(quantile(probe.latencies, 0.5)),
      p90: round(quantile(probe.latencies, 0.9)),
      p99: round(quantile(probe.latencies, 0.99)),
      max: round(Math.max(0, ...probe.latencies)),
      n: probe.latencies.length,
    },
    frames: frameStats(probe.frames),
    loaf: {
      count: probe.loafs.length,
      totalMs: round(probe.loafs.reduce((sum, entry) => sum + entry.duration, 0)),
      blockingMs: round(probe.loafs.reduce((sum, entry) => sum + entry.blockingDuration, 0)),
    },
    busyPct: round((delta("TaskDuration") / wallS) * 100),
    scriptPct: round((delta("ScriptDuration") / wallS) * 100),
    layoutsPerS: round(delta("LayoutCount") / wallS),
    layoutMsPerS: round((delta("LayoutDuration") * 1000) / wallS),
    styleRecalcsPerS: round(delta("RecalcStyleCount") / wallS),
    styleMsPerS: round((delta("RecalcStyleDuration") * 1000) / wallS),
    gcMs: round(gcMs),
    heapBeforeMiB: round(heap.before / 2 ** 20),
    heapAfterMiB: round(heap.after / 2 ** 20),
    nodes: heap.nodes,
    followGap: { p50: quantile(probe.gaps, 0.5), p90: quantile(probe.gaps, 0.9), max: Math.max(-1, ...probe.gaps), end: probe.gaps.at(-1) ?? -1 },
    topSelf: self.filter((entry) => !entry.frame.startsWith("(idle)")).slice(0, 25),
  }
}
