import fs from "node:fs/promises"
import path from "node:path"
import type { DistBytes } from "./bytes"
import type { StepResult } from "./scenarios"
import type { WaterfallRow } from "./waterfall"

export type RunMeta = {
  readonly label: string
  readonly target: string
  readonly profiles: readonly string[]
  readonly reps: number
  readonly cpu: number
  readonly startedAt: string
  readonly elapsedMs: number
  readonly host: string
}

const MARK_COLUMNS = ["fcp", "shell", "rail", "session-text", "session-fold", "session-two-screens", "session-settled", "composer", "login", "marketplace", "settings"] as const

function median(values: readonly number[]) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (finite.length === 0) return undefined
  const middle = Math.floor(finite.length / 2)
  return finite.length % 2 === 1 ? finite[middle] : ((finite[middle - 1] ?? 0) + (finite[middle] ?? 0)) / 2
}

function fmt(value: number | undefined, digits = 0) {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits)
}

function kb(bytes: number | undefined) {
  return bytes === undefined ? "—" : (bytes / 1000).toFixed(1)
}

function markValue(result: StepResult, column: string) {
  const exact = result.marks[column]
  if (exact !== undefined) return exact
  const prefixed = Object.entries(result.marks).find(([name]) => name.startsWith(`${column}:`))
  return prefixed?.[1]
}

function table(header: readonly string[], rows: readonly (readonly string[])[]) {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")
}

export function groupKey(result: StepResult) {
  return `${result.profile}\u0000${result.scenario}\u0000${result.step}`
}

export function groups(results: readonly StepResult[]) {
  const map = new Map<string, StepResult[]>()
  for (const result of results) map.set(groupKey(result), [...(map.get(groupKey(result)) ?? []), result])
  return [...map.values()]
}

/** The run whose headline sits at the median, so every table about one run describes a typical one. */
export function representative(group: readonly StepResult[]) {
  const sorted = [...group].filter((result) => Number.isFinite(result.primary.ms)).sort((a, b) => a.primary.ms - b.primary.ms)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? group[0]
}

function readinessTable(results: readonly StepResult[]) {
  const rows = groups(results).map((group) => {
    const [first] = group
    const med = (pick: (result: StepResult) => number | undefined) => median(group.map((result) => pick(result) ?? Number.NaN))
    return [
      `${first.scenario}/${first.step}`, first.profile, first.cache, String(group.length),
      `${first.primary.name} ${fmt(med((result) => result.primary.ms))}`,
      ...MARK_COLUMNS.map((column) => fmt(med((result) => markValue(result, column)))),
      fmt(med((result) => result.lcp?.at)),
      fmt(med((result) => result.waterfall.requests)), kb(med((result) => result.waterfall.transferBytes)), fmt(med((result) => result.waterfall.waves)),
      fmt(med((result) => result.mainThread?.busyMs)), fmt(med((result) => result.mainThread?.tbtMs)), fmt(med((result) => result.mainThread?.longTasks.length)),
      first.keys ? `${fmt(med((result) => result.keys?.p50), 1)} / ${fmt(med((result) => result.keys?.p95), 1)} / ${fmt(med((result) => result.keys?.max), 1)}` : "—",
    ]
  })
  return table(["scenario", "profile", "cache", "n", "headline ms", ...MARK_COLUMNS, "lcp", "requests", "kB", "waves", "busy ms", "TBT ms", "long tasks", "key p50/p95/max"], rows)
}

function waterfallRows(rows: readonly WaterfallRow[]) {
  return table(
    ["start", "ms", "wave", "waited on (gap)", "kind", "path", "ttfb", "dl", "xfer kB", "raw kB", "enc", "cache", "prio", "initiator"],
    rows.map((row) => [
      fmt(row.startMs), fmt(row.totalMs), String(row.wave), row.waitedOn ? `${row.waitedOn} (${fmt(row.gapMs)})` : "", row.kind, row.path.replace(/\|/g, "\\|"),
      fmt(row.ttfbMs), fmt(row.downloadMs), kb(row.transferBytes), kb(row.decodedBytes), row.encoding ?? "", row.cache === "none" ? "" : row.cache, row.priority, row.initiator.replace(/\|/g, "\\|"),
    ]),
  )
}

function mainThreadSection(result: StepResult) {
  const main = result.mainThread
  if (!main) return "_no trace_"
  const totals = Object.entries(main.totals).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${ms.toFixed(0)}`).join(", ")
  const scripts = table(["script", "compile ms", "evaluate ms", "streamed compile ms"], main.scripts.slice(0, 20).map((script) => [script.url, fmt(script.compileMs, 1), fmt(script.evaluateMs, 1), fmt(script.streamedCompileMs, 1)]))
  const sheets = main.styleSheets.length ? table(["stylesheet", "parse ms"], main.styleSheets.slice(0, 8).map((sheet) => [sheet.url, fmt(sheet.parseMs, 1)])) : ""
  const tasks = table(["start", "ms", "top of the task"], main.longTasks.slice(0, 12).map((task) => [fmt(task.startMs), fmt(task.durMs), task.top.join("<br>").replace(/\|/g, "\\|")]))
  return [`Window ${main.windowMs.toFixed(0)} ms, main thread busy ${main.busyMs.toFixed(0)} ms, TBT ${main.tbtMs.toFixed(0)} ms, ${main.longTasks.length} long tasks.`, "", `Totals (ms): ${totals}`, "", scripts, "", sheets, "", tasks].join("\n")
}

function bytesSection(bytes: DistBytes) {
  const initial = bytes.chunks.filter((chunk) => chunk.initial)
  const sum = (key: "raw" | "gzip" | "br") => initial.reduce((total, chunk) => total + chunk[key], 0)
  const chunkTable = table(["asset", "raw kB", "gzip kB", "br kB"], [
    ...initial.map((chunk) => [chunk.path, kb(chunk.raw), kb(chunk.gzip), kb(chunk.br)]),
    ["**initial total**", kb(sum("raw")), kb(sum("gzip")), kb(sum("br"))],
  ])
  const lazy = bytes.chunks.filter((chunk) => !chunk.initial && chunk.kind !== "other")
  const lazyTotal = lazy.reduce((total, chunk) => total + chunk.raw, 0)
  const sources = initial.flatMap((chunk) => (chunk.sources ?? []).slice(0, 30).map((source) => [chunk.path.split("/").pop() ?? "", source.source, kb(source.bytes)]))
  return [
    `${initial.length} initial assets; ${lazy.length} lazy JS/CSS chunks totalling ${kb(lazyTotal)} kB raw.`, "", chunkTable, "",
    "Generated bytes of each initial JS chunk by source (top 30 per chunk, from the hidden source maps):", "", table(["chunk", "source", "kB"], sources),
  ].join("\n")
}

function lazyChunkSection(results: readonly StepResult[]) {
  const rows = groups(results).flatMap((group) => {
    const rep = representative(group)
    return rep.lazyChunks.map((chunk) => [`${rep.scenario}/${rep.step}`, rep.profile, chunk.path, fmt(chunk.startMs), fmt(chunk.totalMs), kb(chunk.transferBytes), chunk.cache === "none" ? "" : chunk.cache])
  })
  return rows.length ? table(["step", "profile", "chunk", "start", "ms", "xfer kB", "cache"], rows) : "_no lazy chunk loaded_"
}

export function renderMarkdown(meta: RunMeta, results: readonly StepResult[], bytes: DistBytes | undefined) {
  const sections = [
    `# Web perf rig: ${meta.label}`, "",
    `Target ${meta.target}. Profiles ${meta.profiles.join(", ")}; ${meta.reps} repetition(s) each; CPU ×${meta.cpu}. Started ${meta.startedAt}, ran ${(meta.elapsedMs / 1000).toFixed(0)} s. Host: ${meta.host}.`, "",
    "Times are milliseconds from the navigation's time origin (boots) or from the trusted press/keydown (interactions); each cell is the median over repetitions. `headline` is the step's own readiness mark.", "",
    "## Readiness", "", readinessTable(results), "",
    "## Lazy chunks by step (representative run)", "", lazyChunkSection(results), "",
  ]
  for (const group of groups(results).filter((group) => group[0].reference === "navigation" || group[0].scenario === "open-session" && group[0].step === "press")) {
    const rep = representative(group)
    sections.push(`## Waterfall: ${rep.scenario}/${rep.step}, ${rep.profile}, rep ${rep.rep}`, "", `${rep.waterfall.requests} requests, ${kb(rep.waterfall.transferBytes)} kB transferred for ${kb(rep.waterfall.decodedBytes)} kB decoded, ${rep.waterfall.waves} dependency waves, last response at ${fmt(rep.waterfall.lastEndMs)} ms.`, "", waterfallRows(rep.waterfall.rows), "", `### Main thread: ${rep.scenario}/${rep.step}, ${rep.profile}`, "", mainThreadSection(rep), "")
  }
  if (bytes) sections.push("## Bytes", "", bytesSection(bytes), "")
  return sections.join("\n")
}

export async function writeReport(out: string, meta: RunMeta, results: readonly StepResult[], bytes: DistBytes | undefined) {
  await fs.mkdir(out, { recursive: true })
  const json = path.join(out, `${meta.label}-summary.json`)
  const md = path.join(out, `${meta.label}-summary.md`)
  await fs.writeFile(json, JSON.stringify({ meta, bytes: bytes ? { chunks: bytes.chunks, initial: [...bytes.initial] } : undefined, results }, null, 1))
  await fs.writeFile(md, renderMarkdown(meta, results, bytes))
  return { json, md }
}
