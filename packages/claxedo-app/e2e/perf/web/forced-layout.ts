import { traceText, type TraceEvent } from "../../harness/trace-events"
import { profileFrameLabel, profileTree, type CpuProfile, type Mapper } from "../panel/trace"
import { forcingFrame, mapTraceFrame } from "../stream-switch/main-thread"
import { round } from "./numbers"

export type ForcedLayout = { readonly where: string; readonly n: number; readonly ms: number }

export type RenderWork = {
  readonly styleRecalcs: number
  readonly styleMs: number
  readonly layouts: number
  readonly layoutMs: number
  readonly forcedN: number
  readonly forcedMs: number
  readonly forced: readonly ForcedLayout[]
}

const SCRIPT = new Set(["FunctionCall", "EvaluateScript", "v8.evaluateModule", "FireAnimationFrame", "TimerFire", "EventDispatch", "RunMicrotasks"])
const RENDER = new Set(["UpdateLayoutTree", "Layout"])

const end = (event: TraceEvent) => event.ts + (event.dur ?? 0)

function outermostScripts(onMain: readonly TraceEvent[]) {
  const out: TraceEvent[] = []
  for (const event of onMain) {
    if (!SCRIPT.has(event.name)) continue
    const previous = out.at(-1)
    if (previous && event.ts < end(previous)) continue
    out.push(event)
  }
  return out
}

function enclosing(event: TraceEvent, scripts: readonly TraceEvent[]) {
  let low = 0
  let high = scripts.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = scripts[middle]
    if (candidate.ts > event.ts) high = middle - 1
    else if (end(candidate) < event.ts) low = middle + 1
    else return candidate
  }
  return undefined
}

export function tidyWhere(where: string) {
  return where.replace(/\S*node_modules\/\.bun\/[^/\s]+\/node_modules\//g, "").replace(/\S*?\/packages\//g, "packages/")
}

function sampledFrames(profile: CpuProfile & { startTime?: number }, mapper: Mapper) {
  const { byId, parent } = profileTree(profile)
  const at: number[] = []
  let now = profile.startTime ?? 0
  for (const delta of profile.timeDeltas) at.push((now += delta))
  return (ts: number) => {
    const index = at.findIndex((sampleAt) => sampleAt >= ts)
    const chain: string[] = []
    for (let id: number | undefined = profile.samples[index < 0 ? at.length - 1 : index]; id !== undefined && chain.length < 2; id = parent.get(id)) {
      const frame = byId.get(id)?.callFrame
      if (frame?.url && !frame.url.includes("vendor")) chain.push(profileFrameLabel(mapper, frame))
    }
    return chain.length ? `${chain.join(" ← ")} (sampled)` : undefined
  }
}

function forcingCode(event: TraceEvent, script: TraceEvent, mapper: Mapper, sampled: ((ts: number) => string | undefined) | undefined) {
  const frame = forcingFrame(event)
  if (frame?.url) return `${frame.functionName || "(anon)"} ${mapTraceFrame(mapper, frame)}`
  const fromProfile = sampled?.(event.ts)
  if (fromProfile) return fromProfile
  const data = script.args?.data ?? {}
  return `${traceText(data.functionName) || script.name} ${(traceText(data.url) ?? "").split("/").pop() ?? ""}`
}

export function renderWork(onMain: readonly TraceEvent[], window: { fromUs: number; toUs: number }, mapper: Mapper, profile: CpuProfile | undefined): RenderWork {
  const inside = onMain.filter((event) => event.ts >= window.fromUs && event.ts <= window.toUs)
  const scripts = outermostScripts(onMain)
  const sampled = profile ? sampledFrames(profile, mapper) : undefined
  const byWhere = new Map<string, { n: number; us: number }>()
  let forcedN = 0
  let forcedUs = 0
  for (const event of inside) {
    if (!RENDER.has(event.name)) continue
    const script = enclosing(event, scripts)
    if (!script) continue
    forcedN += 1
    forcedUs += event.dur ?? 0
    const where = tidyWhere(`${event.name === "Layout" ? "layout" : "style"} ← ${forcingCode(event, script, mapper, sampled)}`)
    const entry = byWhere.get(where) ?? { n: 0, us: 0 }
    byWhere.set(where, { n: entry.n + 1, us: entry.us + (event.dur ?? 0) })
  }
  const sum = (name: string) => inside.filter((event) => event.name === name).reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
  return {
    styleRecalcs: inside.filter((event) => event.name === "UpdateLayoutTree").length,
    styleMs: round(sum("UpdateLayoutTree")),
    layouts: inside.filter((event) => event.name === "Layout").length,
    layoutMs: round(sum("Layout")),
    forcedN,
    forcedMs: round(forcedUs / 1000),
    forced: [...byWhere.entries()].map(([where, entry]) => ({ where, n: entry.n, ms: round(entry.us / 1000) })).sort((a, b) => b.ms - a.ms).slice(0, 10),
  }
}
