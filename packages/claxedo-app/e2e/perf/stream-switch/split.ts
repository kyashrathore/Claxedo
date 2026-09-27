import fs from "node:fs"
import { createSourceMapper, type TraceEvent } from "../panel/trace"

const [file, distDir] = process.argv.slice(2) as [string, string]
const events = (JSON.parse(fs.readFileSync(file, "utf8")) as { traceEvents: TraceEvent[] }).traceEvents
const mapper = createSourceMapper(distDir)
const main = events.find((event) => event.name === "thread_name" && (event.args as { name?: string } | undefined)?.name === "CrRendererMain")
if (!main) throw new Error("no renderer main thread")
const onMain = events.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === "X" && typeof event.dur === "number").sort((a, b) => a.ts - b.ts)
const inputs = onMain.filter((event) => event.name === "EventDispatch" && event.args?.data?.type === "pointerdown")
const ms = (us: number) => Math.round(us / 100) / 10

function forcedSource(event: TraceEvent) {
  const top = (event.args as { beginData?: { stackTrace?: { url: string; lineNumber: number; columnNumber: number }[] } }).beginData?.stackTrace?.[0]
  if (!top) return undefined
  const url = top.url.split("/").pop() ?? ""
  return url ? mapper.map(url, top.lineNumber, top.columnNumber - 1) : "(no url)"
}

const rows = inputs.map((input, index) => {
  const task = onMain.find((event) => event.name === "RunTask" && event.ts <= input.ts && event.ts + (event.dur ?? 0) >= input.ts + (input.dur ?? 0))
  const clickTask = onMain
    .filter((event) => event.name === "RunTask" && event.ts >= input.ts && event.ts < input.ts + 40_000 && event !== task)
    .reduce<TraceEvent | undefined>((longest, event) => ((event.dur ?? 0) > (longest?.dur ?? 0) ? event : longest), task)
  const start = Math.min(task?.ts ?? input.ts, clickTask?.ts ?? input.ts)
  const end = Math.max((task?.ts ?? 0) + (task?.dur ?? 0), (clickTask?.ts ?? 0) + (clickTask?.dur ?? 0))
  const inside = onMain.filter((event) => event.ts >= start && event.ts + (event.dur ?? 0) <= end)
  const layouts = inside.filter((event) => event.name === "Layout")
  const forced = new Map<string, number>()
  let framed = 0
  for (const layout of layouts) {
    const source = forcedSource(layout)
    if (source) forced.set(source, (forced.get(source) ?? 0) + (layout.dur ?? 0))
    else framed += layout.dur ?? 0
  }
  const sum = (name: string) => inside.filter((event) => event.name === name).reduce((total, event) => total + (event.dur ?? 0), 0)
  const paint = onMain.find((event) => (event.name === "Paint" || event.name === "Commit") && event.ts >= end)
  return {
    index,
    task: ms(end - start),
    forced: [...forced].map(([source, us]) => `${ms(us)} ${source}`),
    forcedTotal: ms([...forced.values()].reduce((total, us) => total + us, 0)),
    frameLayout: ms(framed),
    style: ms(sum("UpdateLayoutTree")),
    parseHtml: ms(sum("ParseHTML")),
    toPaint: paint ? ms(paint.ts - input.ts) : -1,
  }
})

for (const row of rows) console.log(`switch ${row.index}: task ${row.task} ms, forced ${row.forcedTotal} ms, frame layout ${row.frameLayout} ms, style ${row.style} ms, ParseHTML ${row.parseHtml} ms, pointerdown→paint ${row.toPaint} ms\n    ${row.forced.join("\n    ")}`)
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
console.log(`median over ${rows.length}: task ${median(rows.map((row) => row.task))} ms, forced ${median(rows.map((row) => row.forcedTotal))} ms, frame layout ${median(rows.map((row) => row.frameLayout))} ms, style ${median(rows.map((row) => row.style))} ms, pointerdown→paint ${median(rows.map((row) => row.toPaint))} ms`)
