import fs from "node:fs"
import type { TraceEvent } from "../../harness/trace-events"
import type { createSourceMapper } from "../panel/trace"

type Mapper = ReturnType<typeof createSourceMapper>
type TraceFrame = { url: string; lineNumber: number; columnNumber: number; functionName?: string }

/** The complete events of the busiest renderer main thread, in time order; a trace of several pages names several. */
export function mainThreadEvents(events: readonly TraceEvent[]) {
  const mains = events.filter((event) => event.name === "thread_name" && (event.args as { name?: string } | undefined)?.name === "CrRendererMain")
  if (mains.length === 0) throw new Error("no renderer main thread")
  const counts = new Map<string, number>()
  for (const event of events) {
    const key = `${event.pid}:${event.tid}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const main = mains.reduce((best, candidate) => (counts.get(`${candidate.pid}:${candidate.tid}`) ?? 0) > (counts.get(`${best.pid}:${best.tid}`) ?? 0) ? candidate : best)
  return events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && typeof event.dur === "number").sort((a, b) => a.ts - b.ts)
}

export function readMainThread(file: string) {
  const events = (JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents: TraceEvent[] }).traceEvents
  const onMain = mainThreadEvents(events)
  const pointerdowns = onMain.filter((event) => event.name === "EventDispatch" && event.args?.data?.type === "pointerdown")
  return { onMain, pointerdowns }
}

export function mapTraceFrame(mapper: Mapper, frame: TraceFrame) {
  const url = frame.url.split("/").pop() ?? ""
  return url ? mapper.map(url, frame.lineNumber, frame.columnNumber - 1) : ""
}

export function forcingFrame(layout: TraceEvent): TraceFrame | undefined {
  return (layout.args as { beginData?: { stackTrace?: TraceFrame[] } }).beginData?.stackTrace?.[0]
}
