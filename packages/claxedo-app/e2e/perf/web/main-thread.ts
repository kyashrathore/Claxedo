import { traceText, type TraceEvent } from "../../harness/trace-events"
import { describeTraceEvent, type Mapper } from "../panel/trace"
import { mainThreadEvents } from "../stream-switch/main-thread"

export type LongTask = { readonly startMs: number; readonly durMs: number; readonly top: readonly string[] }

export type ScriptCost = { readonly url: string; readonly compileMs: number; readonly evaluateMs: number; readonly streamedCompileMs: number }

export type MainThreadSummary = {
  readonly windowMs: number
  readonly busyMs: number
  readonly tbtMs: number
  readonly totals: Readonly<Record<string, number>>
  readonly longTasks: readonly LongTask[]
  readonly scripts: readonly ScriptCost[]
  readonly styleSheets: readonly { readonly url: string; readonly parseMs: number }[]
}

const TOTALS = ["RunTask", "FunctionCall", "EvaluateScript", "v8.evaluateModule", "v8.compile", "V8.CompileCode", "ParseHTML", "ParseAuthorStyleSheet", "UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit", "RunMicrotasks", "TimerFire", "EventDispatch", "HitTest", "ResourceReceivedData", "XHRReadyStateChange"]
const COMPILE = /compile|deserialize/i
const EVALUATE = /^(EvaluateScript|v8\.evaluateModule)$/
const GC = /GC|ThreadState::completeSweep|CollectGarbage/
const LONG_TASK_US = 50_000
const NO_MAPPER: Mapper = { map: (file, line, column) => `${file}:${line}:${column}` }

function round(value: number) {
  return Math.round(value * 10) / 10
}

function scriptUrl(event: TraceEvent) {
  const data = event.args?.data ?? {}
  return traceText(data.url) ?? traceText(data.fileName) ?? traceText((event.args as { fileName?: unknown } | undefined)?.fileName) ?? ""
}

function topOf(task: TraceEvent, onMain: readonly TraceEvent[], mapper: Mapper) {
  const taskEnd = task.ts + (task.dur ?? 0)
  const inside = onMain.filter((event) => event !== task && event.ts >= task.ts && event.ts + (event.dur ?? 0) <= taskEnd && (event.dur ?? 0) >= 1000)
  const direct: TraceEvent[] = []
  for (const event of inside) {
    const parent = direct.at(-1)
    if (parent && event.ts < parent.ts + (parent.dur ?? 0)) continue
    direct.push(event)
  }
  return direct.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0)).slice(0, 4).map((event) => {
    const line = describeTraceEvent(event, mapper)
    const url = EVALUATE.test(event.name) || COMPILE.test(event.name) ? scriptUrl(event).split("/").pop() : ""
    return url ? `${line} ${url}` : line
  })
}

/** Main-thread work between two monotonic trace times (µs), with every script's compile and evaluate cost in the window. */
export function summarizeMainThread(events: readonly TraceEvent[], window: { fromUs: number; toUs: number }, mapper: Mapper = NO_MAPPER): MainThreadSummary {
  const onMain = mainThreadEvents(events).filter((event) => event.ts + (event.dur ?? 0) >= window.fromUs && event.ts <= window.toUs)
  const totals: Record<string, number> = {}
  const add = (name: string, us: number) => (totals[name] = round((totals[name] ?? 0) + us / 1000))
  const scripts = new Map<string, { compileMs: number; evaluateMs: number; streamedCompileMs: number }>()
  const script = (url: string) => scripts.get(url) ?? scripts.set(url, { compileMs: 0, evaluateMs: 0, streamedCompileMs: 0 }).get(url)!
  const styleSheets = new Map<string, number>()
  let busyUs = 0
  let tbtUs = 0
  const longTasks: LongTask[] = []
  for (const event of onMain) {
    const dur = event.dur ?? 0
    if (TOTALS.includes(event.name)) add(event.name, dur)
    if (GC.test(event.name)) add("GC", dur)
    if (event.name === "RunTask") {
      busyUs += dur
      if (dur >= LONG_TASK_US) {
        tbtUs += dur - LONG_TASK_US
        longTasks.push({ startMs: round((event.ts - window.fromUs) / 1000), durMs: round(dur / 1000), top: topOf(event, onMain, mapper) })
      }
    }
    const url = scriptUrl(event)
    if (url && EVALUATE.test(event.name)) script(url).evaluateMs = round(script(url).evaluateMs + dur / 1000)
    else if (url && COMPILE.test(event.name)) script(url).compileMs = round(script(url).compileMs + dur / 1000)
    if (event.name === "ParseAuthorStyleSheet") {
      const sheet = traceText(event.args?.data?.styleSheetUrl) ?? "(inline)"
      styleSheets.set(sheet, round((styleSheets.get(sheet) ?? 0) + dur / 1000))
    }
  }
  const mainTid = mainThreadEvents(events)[0]?.tid
  for (const event of events) {
    if (event.tid === mainTid || event.ph !== "X" || !COMPILE.test(event.name) || event.ts < window.fromUs || event.ts > window.toUs) continue
    const url = scriptUrl(event)
    if (url) script(url).streamedCompileMs = round(script(url).streamedCompileMs + (event.dur ?? 0) / 1000)
  }
  return {
    windowMs: round((window.toUs - window.fromUs) / 1000),
    busyMs: round(busyUs / 1000),
    tbtMs: round(tbtUs / 1000),
    totals,
    longTasks: longTasks.sort((a, b) => b.durMs - a.durMs),
    scripts: [...scripts.entries()].map(([url, cost]) => ({ url: url.split("/").pop() ?? url, ...cost })).sort((a, b) => b.compileMs + b.evaluateMs - a.compileMs - a.evaluateMs),
    styleSheets: [...styleSheets.entries()].map(([url, parseMs]) => ({ url: url.split("/").pop() ?? url, parseMs })).sort((a, b) => b.parseMs - a.parseMs),
  }
}
