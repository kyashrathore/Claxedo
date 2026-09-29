import type { TraceEvent } from "../../harness/trace-events"
import { createSourceMapper } from "../panel/trace"
import { forcingFrame, mapTraceFrame, readMainThread } from "./main-thread"

const [file, distDir, spanArg = "200"] = process.argv.slice(2) as [string, string, string?]
const SPAN_US = Number(spanArg) * 1000
const mapper = createSourceMapper(distDir)
const { onMain, pointerdowns: inputs } = readMainThread(file)
const interesting = new Set(["FunctionCall", "EventDispatch", "TimerFire", "FireAnimationFrame", "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "Layerize", "Commit", "RunMicrotasks", "HitTest", "ParseHTML", "IntersectionObserverController::computeIntersections", "ResizeObserverController::DeliverObservations", "UpdateLayer", "ScrollLayer"])

function label(event: TraceEvent) {
  const data = event.args?.data ?? {}
  const ms = ((event.dur ?? 0) / 1000).toFixed(1).padStart(6)
  if (event.name === "FunctionCall") {
    return `${ms} FunctionCall ${String(data.functionName || "(anon)")} ${mapTraceFrame(mapper, { url: String(data.url ?? ""), lineNumber: Number(data.lineNumber ?? 1), columnNumber: Number(data.columnNumber ?? 1) })}`
  }
  if (event.name === "EventDispatch") return `${ms} Event:${String(data.type)}`
  if (event.name === "Layout") {
    const begin = (event.args as { beginData?: { dirtyObjects?: number; totalObjects?: number; partialLayout?: boolean } }).beginData
    return `${ms} Layout dirty=${begin?.dirtyObjects} total=${begin?.totalObjects}${forcingFrame(event) ? " FORCED" : ""}`
  }
  if (event.name === "UpdateLayoutTree") return `${ms} UpdateLayoutTree elements=${String((event.args as { elementCount?: number }).elementCount ?? data.elementCount ?? "")}`
  return `${ms} ${event.name}`
}

function forcedBy(event: TraceEvent) {
  const top = forcingFrame(event)
  return top ? ` <- ${top.functionName || "(anon)"} ${mapTraceFrame(mapper, top)}` : ""
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
