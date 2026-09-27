import fs from "node:fs"
import { createSourceMapper, type TraceEvent } from "../panel/trace"

const [file, distDir, spanArg = "200"] = process.argv.slice(2) as [string, string, string?]
const SPAN_US = Number(spanArg) * 1000
const events = (JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents: TraceEvent[] }).traceEvents
const mapper = createSourceMapper(distDir)
const main = events.find((event) => event.name === "thread_name" && (event.args as { name?: string } | undefined)?.name === "CrRendererMain")
if (!main) throw new Error("no renderer main thread")
const onMain = events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && typeof event.dur === "number").sort((a, b) => a.ts - b.ts)
const inputs = onMain.filter((event) => event.name === "EventDispatch" && event.args?.data?.type === "pointerdown")
const interesting = new Set(["FunctionCall", "EventDispatch", "TimerFire", "FireAnimationFrame", "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "Layerize", "Commit", "RunMicrotasks", "HitTest", "ParseHTML", "IntersectionObserverController::computeIntersections", "ResizeObserverController::DeliverObservations", "UpdateLayer", "ScrollLayer"])

function label(event: TraceEvent) {
  const data = event.args?.data ?? {}
  const ms = ((event.dur ?? 0) / 1000).toFixed(1).padStart(6)
  if (event.name === "FunctionCall") {
    const url = String(data.url ?? "").split("/").pop() ?? ""
    return `${ms} FunctionCall ${String(data.functionName || "(anon)")} ${url ? mapper.map(url, Number(data.lineNumber ?? 1), Number(data.columnNumber ?? 1) - 1) : ""}`
  }
  if (event.name === "EventDispatch") return `${ms} Event:${String(data.type)}`
  if (event.name === "Layout") {
    const begin = (event.args as { beginData?: { dirtyObjects?: number; totalObjects?: number; partialLayout?: boolean } }).beginData
    return `${ms} Layout dirty=${begin?.dirtyObjects} total=${begin?.totalObjects}${event.args?.data?.stackTrace ? " FORCED" : ""}`
  }
  if (event.name === "UpdateLayoutTree") return `${ms} UpdateLayoutTree elements=${String((event.args as { elementCount?: number }).elementCount ?? data.elementCount ?? "")}`
  return `${ms} ${event.name}`
}

function forcedBy(event: TraceEvent) {
  const stack = (event.args as { beginData?: { stackTrace?: { url: string; lineNumber: number; columnNumber: number; functionName: string }[] } }).beginData?.stackTrace
  const top = stack?.[0]
  if (!top) return ""
  const url = top.url.split("/").pop() ?? ""
  return ` <- ${top.functionName || "(anon)"} ${url ? mapper.map(url, top.lineNumber, top.columnNumber - 1) : ""}`
}

for (const [index, input] of inputs.entries()) {
  const end = input.ts + SPAN_US
  const tasks = onMain.filter((event) => event.name === "RunTask" && event.ts + (event.dur ?? 0) >= input.ts && event.ts <= end && (event.dur ?? 0) >= 1000)
  console.log(`\n=== switch ${index} pointerdown at ${(input.ts / 1000).toFixed(1)}ms`)
  for (const task of tasks) {
    const taskEnd = task.ts + (task.dur ?? 0)
    console.log(`+${((task.ts - input.ts) / 1000).toFixed(1)}ms RunTask ${((task.dur ?? 0) / 1000).toFixed(1)}ms`)
    const inside = onMain.filter((event) => event !== task && event.ts >= task.ts && event.ts + (event.dur ?? 0) <= taskEnd && interesting.has(event.name) && (event.dur ?? 0) >= 300)
    const depth = (event: TraceEvent) => inside.filter((other) => other !== event && other.ts <= event.ts && other.ts + (other.dur ?? 0) >= event.ts + (event.dur ?? 0) && (other.dur ?? 0) > (event.dur ?? 0)).length
    for (const event of inside) {
      const level = depth(event)
      if (level > 2) continue
      console.log(`${"  ".repeat(level + 1)}+${((event.ts - input.ts) / 1000).toFixed(1)} ${label(event)}${event.name === "Layout" ? forcedBy(event) : ""}`)
    }
  }
}
