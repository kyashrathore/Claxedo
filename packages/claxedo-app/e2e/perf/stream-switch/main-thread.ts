import fs from "node:fs"
import type { TraceEvent } from "../../harness/trace-events"
import type { createSourceMapper } from "../panel/trace"

type Mapper = ReturnType<typeof createSourceMapper>
type TraceFrame = { url: string; lineNumber: number; columnNumber: number; functionName?: string }

export function readMainThread(file: string) {
  const events = (JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents: TraceEvent[] }).traceEvents
  const main = events.find((event) => event.name === "thread_name" && (event.args as { name?: string } | undefined)?.name === "CrRendererMain")
  if (!main) throw new Error("no renderer main thread")
  const onMain = events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && typeof event.dur === "number").sort((a, b) => a.ts - b.ts)
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
