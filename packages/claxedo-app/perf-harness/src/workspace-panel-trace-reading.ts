import type { TraceEvent } from "./trace-events"
import {
  readList,
  readLiteral,
  readNumber,
  readNumberFields,
  readRecord,
  readRecords,
  readText,
} from "./page-value"

export const COUNTER_START_MARK = "claxedo-public-panel-counter-start"
export const COUNTER_END_MARK = "claxedo-public-panel-counter-end"

export type RendererTrace = {
  clock: "performance.now"
  transitionMode: "animated" | "none"
  milestones: Array<{ id: string; at: number }>
  frameTimestampsMs: number[]
  longAnimationFrames: Array<{
    start: number
    duration: number
    blockingDuration: number
    renderStart: number
    styleAndLayoutStart: number
    scripts: Array<{
      sourceURL: string
      functionName: string
      invokerType: string
      duration: number
      forcedStyleAndLayoutDuration: number
    }>
  }>
  counterInterval: { start: number; end: number }
  counters: {
    scriptDurationMs: number
    styleRecalcDurationMs: number
    layoutDurationMs: number
    taskDurationMs: number
  }
}

/**
 * The measured trace the renderer hands back, read into `RendererTrace`.
 *
 * The page builds this from live `PerformanceEntry` data and it crosses as
 * JSON, so `clock` and `transitionMode` are verified rather than echoed: a
 * renderer answering a different clock would otherwise be published as if it
 * had answered `performance.now`.
 */
export function readMeasuredTrace(value: unknown) {
  const record = readRecord(value)
  return {
    clock: readLiteral(record.clock, ["performance.now"]),
    transitionMode: readLiteral(record.transitionMode, ["animated", "none"]),
    milestones: readRecords(record.milestones).map((milestone) => ({
      id: readText(milestone.id),
      at: readNumber(milestone.at),
    })),
    frameTimestampsMs: readList(record.frameTimestampsMs).map(readNumber),
    longAnimationFrames: readLongAnimationFrames(record.longAnimationFrames),
    counterInterval: readNumberFields(record.counterInterval, ["start", "end"]),
  }
}

function readLongAnimationFrames(value: unknown): RendererTrace["longAnimationFrames"] {
  return readRecords(value).map((entry) => ({
    ...readNumberFields(entry, ["start", "duration", "blockingDuration", "renderStart", "styleAndLayoutStart"]),
    scripts: readRecords(entry.scripts).map((script) => ({
      sourceURL: readText(script.sourceURL),
      functionName: readText(script.functionName),
      invokerType: readText(script.invokerType),
      ...readNumberFields(script, ["duration", "forcedStyleAndLayoutDuration"]),
    })),
  }))
}

export function rendererCounters(events: TraceEvent[]) {
  const start = events.find((event) => event.name === COUNTER_START_MARK)
  const end = events.find((event) => event.name === COUNTER_END_MARK && event.pid === start?.pid && event.tid === start?.tid)
  if (!start || !end) throw new Error("Claxedo counter trace is missing its action boundary marks")
  return {
    scriptDurationMs: traceDuration(events, new Set(["EventDispatch", "TimerFire", "FireAnimationFrame", "RunMicrotasks"]), start, end),
    styleRecalcDurationMs: traceDuration(events, new Set(["UpdateLayoutTree", "RecalculateStyles", "RecalculateStyle"]), start, end),
    layoutDurationMs: traceDuration(events, new Set(["Layout"]), start, end),
    taskDurationMs: traceDuration(events, new Set(["RunTask"]), start, end),
  }
}

function traceDuration(events: TraceEvent[], names: Set<string>, start: TraceEvent, end: TraceEvent) {
  const intervals = events
    .filter((event) => event.pid === start.pid && event.tid === start.tid && event.ph === "X" && Number.isFinite(event.ts) && Number.isFinite(event.dur) && [...names].some((name) => event.name === name || event.name?.endsWith(`::${name}`)))
    .map((event) => [Math.max(start.ts, event.ts), Math.min(end.ts, event.ts + (event.dur ?? 0))] as const)
    .filter(([left, right]) => right > left)
    .toSorted(([left], [right]) => left - right)
  let total = 0
  let left = Number.NaN
  let right = Number.NaN
  for (const [nextLeft, nextRight] of intervals) {
    if (!Number.isFinite(left)) { left = nextLeft; right = nextRight; continue }
    if (nextLeft <= right) { right = Math.max(right, nextRight); continue }
    total += right - left
    left = nextLeft
    right = nextRight
  }
  if (Number.isFinite(left)) total += right - left
  return total / 1_000
}
