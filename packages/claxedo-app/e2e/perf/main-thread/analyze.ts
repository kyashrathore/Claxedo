import type { TraceEvent } from "../../harness/trace-events"
import { profileFrameLabel, profileTree, type CpuProfile } from "../panel/trace"
import { compileFile, isScriptCompile, jsFrameAt, tidyWhere, type Mapper } from "./trace-names"

export type Window = { start: number; ready: number; end: number }

export type Phase = {
  ms: number
  busyMs: number
  cpuMs: number
  tbtMs: number
  longTasks: number
  longestMs: number
  scriptMs: number
  compileMs: number
  styleN: number
  styleMs: number
  styleElements: number
  layoutN: number
  layoutMs: number
  forcedN: number
  forcedMs: number
  paintMs: number
  gcMs: number
}

export type LongTask = { atMs: number; ms: number; top: string[] }
export type Attribution = { where: string; n: number; ms: number }

export type Analysis = {
  ready: Phase
  tail: Phase
  chunks: Attribution[]
  longTasks: LongTask[]
  forced: Attribution[]
  topSelf: Attribution[]
}

const PAINT = new Set(["Paint", "PrePaint", "Layerize", "Commit", "UpdateLayer", "PaintImage", "RasterTask"])
const GC = new Set(["MinorGC", "MajorGC", "V8.GC_SCAVENGER", "V8.GC_MARK_COMPACTOR", "BlinkGC.AtomicPhase"])
const SCRIPT = new Set(["FunctionCall", "EvaluateScript", "v8.evaluateModule", "RunMicrotasks", "TimerFire", "FireAnimationFrame", "EventDispatch"])
const LONG_TASK_US = 50_000

const end = (event: TraceEvent) => event.ts + (event.dur ?? 0)

function topLevel(events: readonly TraceEvent[], names: ReadonlySet<string>) {
  const out: TraceEvent[] = []
  for (const event of events) {
    if (!names.has(event.name)) continue
    const previous = out.at(-1)
    if (previous && event.ts < end(previous)) continue
    out.push(event)
  }
  return out
}

function enclosedByScript(event: TraceEvent, scripts: readonly TraceEvent[]) {
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

function isDevtools(event: TraceEvent) {
  return event.name === "Receive mojo message" && (event.args as { chrome_mojo_event_info?: { mojo_interface_tag?: string } } | undefined)?.chrome_mojo_event_info?.mojo_interface_tag === "blink.mojom.DevToolsSession"
}

function appTasks(main: readonly TraceEvent[]) {
  const instrumented = new Set<TraceEvent>()
  const dispatches = main.filter((event) => event.name === "EventDispatch")
  const tasks = main.filter((event) => event.name === "RunTask")
  for (const message of main.filter(isDevtools)) {
    const task = tasks.find((candidate) => candidate.ts <= message.ts && end(message) <= end(candidate))
    if (!task || (message.dur ?? 0) < 0.9 * (task.dur ?? 0)) continue
    if (dispatches.some((dispatch) => dispatch.ts >= task.ts && dispatch.ts < end(task))) continue
    instrumented.add(task)
  }
  return tasks.filter((task) => !instrumented.has(task))
}

function phase(main: readonly TraceEvent[], tasksOf: readonly TraceEvent[], from: number, to: number, scripts: readonly TraceEvent[]): Phase {
  const inside = main.filter((event) => event.ts >= from && event.ts < to)
  const tasks = tasksOf.filter((event) => event.ts >= from && event.ts < to)
  const sum = (names: ReadonlySet<string> | string) => inside.filter((event) => (typeof names === "string" ? event.name === names : names.has(event.name))).reduce((total, event) => total + (event.dur ?? 0), 0) / 1000
  const styles = inside.filter((event) => event.name === "UpdateLayoutTree")
  const layouts = inside.filter((event) => event.name === "Layout")
  const forced = [...styles, ...layouts].filter((event) => enclosedByScript(event, scripts))
  return {
    ms: (to - from) / 1000,
    busyMs: tasks.reduce((total, task) => total + (task.dur ?? 0), 0) / 1000,
    cpuMs: tasks.reduce((total, task) => total + ((task as { tdur?: number }).tdur ?? 0), 0) / 1000,
    tbtMs: tasks.reduce((total, task) => total + Math.max(0, (task.dur ?? 0) - LONG_TASK_US), 0) / 1000,
    longTasks: tasks.filter((task) => (task.dur ?? 0) > LONG_TASK_US).length,
    longestMs: tasks.reduce((longest, task) => Math.max(longest, task.dur ?? 0), 0) / 1000,
    scriptMs: topLevel(inside, SCRIPT).reduce((total, event) => total + (event.dur ?? 0), 0) / 1000,
    compileMs: inside.filter(isScriptCompile).reduce((total, event) => total + (event.dur ?? 0), 0) / 1000,
    styleN: styles.length,
    styleMs: sum("UpdateLayoutTree"),
    styleElements: styles.reduce((total, event) => total + Number((event.args as { elementCount?: number } | undefined)?.elementCount ?? event.args?.data?.elementCount ?? 0), 0),
    layoutN: layouts.length,
    layoutMs: sum("Layout"),
    forcedN: forced.length,
    forcedMs: forced.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000,
    paintMs: sum(PAINT),
    gcMs: sum(GC),
  }
}

function group(rows: readonly { where: string; us: number }[], limit: number): Attribution[] {
  const out = new Map<string, Attribution>()
  for (const row of rows) {
    const where = tidyWhere(row.where)
    const current = out.get(where) ?? { where, n: 0, ms: 0 }
    current.n += 1
    current.ms += row.us / 1000
    out.set(where, current)
  }
  return [...out.values()].sort((a, b) => b.ms - a.ms).slice(0, limit)
}

type Samples = { at: number[]; node: number[]; delta: number[] }

function samplesOf(profile: CpuProfile & { startTime: number }): Samples {
  const at: number[] = []
  let now = profile.startTime
  for (const delta of profile.timeDeltas) {
    now += delta
    at.push(now)
  }
  return { at, node: profile.samples, delta: profile.timeDeltas.slice(1).concat(0) }
}

const IDLE = new Set(["(idle)", "(program)", "(root)"])

function selfIn(profile: CpuProfile, samples: Samples, mapper: Mapper, from: number, to: number, limit: number) {
  const { byId } = profileTree(profile)
  const rows: { where: string; us: number }[] = []
  for (let index = 0; index < samples.at.length; index += 1) {
    const at = samples.at[index]
    if (at < from || at >= to) continue
    const frame = byId.get(samples.node[index])?.callFrame
    if (!frame || IDLE.has(frame.functionName)) continue
    rows.push({ where: profileFrameLabel(mapper, frame), us: samples.delta[index] ?? 0 })
  }
  return group(rows, limit).map((row) => ({ ...row, n: 0 }))
}

export function analyze(events: readonly TraceEvent[], profile: CpuProfile & { startTime: number }, window: Window, mapper: Mapper, thread: { pid: number; tid: number }): Analysis {
  const main = events.filter((event) => event.pid === thread.pid && event.tid === thread.tid && event.ph === "X" && typeof event.dur === "number").sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0))
  const scripts = topLevel(main, new Set(["FunctionCall", "EvaluateScript", "v8.evaluateModule", "FireAnimationFrame", "TimerFire", "EventDispatch", "RunMicrotasks"]))
  const samples = samplesOf(profile)
  const all = appTasks(main)
  const tasks = all.filter((event) => event.ts >= window.start && event.ts < window.end && (event.dur ?? 0) > LONG_TASK_US)
  const forced = main.filter((event) => (event.name === "Layout" || event.name === "UpdateLayoutTree") && event.ts >= window.start && event.ts < window.end).flatMap((event) => {
    const script = enclosedByScript(event, scripts)
    return script ? [{ where: `${event.name === "Layout" ? "layout" : "style"} ← ${jsFrameAt(event, script, samples, profile, mapper)}`, us: event.dur ?? 0 }] : []
  })
  const chunks = events.filter((event) => event.pid === thread.pid && event.ph === "X" && isScriptCompile(event) && event.ts >= window.start && event.ts < window.end).map((event) => ({ where: `${event.name} ${compileFile(event)}`, us: event.dur ?? 0 }))
  return {
    ready: phase(main, all, window.start, window.ready, scripts),
    tail: phase(main, all, window.ready, window.end, scripts),
    chunks: group(chunks, 24),
    longTasks: tasks.map((task) => ({ atMs: (task.ts - window.start) / 1000, ms: (task.dur ?? 0) / 1000, top: selfIn(profile, samples, mapper, task.ts, end(task), 6).map((row) => `${row.ms.toFixed(1)} ${row.where}`) })),
    forced: group(forced, 12),
    topSelf: selfIn(profile, samples, mapper, window.start, window.end, 30),
  }
}
