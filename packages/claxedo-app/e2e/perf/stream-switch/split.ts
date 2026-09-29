import type { TraceEvent } from "../../harness/trace-events"
import { createSourceMapper } from "../panel/trace"
import { forcingFrame, mapTraceFrame, readMainThread } from "./main-thread"

const [file, distDir] = process.argv.slice(2) as [string, string]
const mapper = createSourceMapper(distDir)
const { onMain, pointerdowns: inputs } = readMainThread(file)
const ms = (us: number) => Math.round(us / 100) / 10

function forcedSource(event: TraceEvent) {
  const top = forcingFrame(event)
  if (!top) return undefined
  return mapTraceFrame(mapper, top) || "(no url)"
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
