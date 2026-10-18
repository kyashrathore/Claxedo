import type { Attribution, Phase } from "./analyze"
import type { ScenarioRow } from "./scenarios"

const PHASE_FIELDS = ["busyMs", "tbtMs", "longTasks", "longestMs", "scriptMs", "compileMs", "styleN", "styleMs", "styleElements", "layoutN", "layoutMs", "forcedN", "forcedMs", "paintMs", "gcMs"] as const satisfies readonly (keyof Phase)[]
const TAIL_FIELDS = ["busyMs", "tbtMs", "longTasks", "longestMs", "forcedN", "styleMs", "layoutMs"] as const satisfies readonly (keyof Phase)[]
const CENSUS_FIELDS = ["railRows", "timelineRows", "elements", "removed", "attributes", "text"] as const

export function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return Number.NaN
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function format(value: number) {
  if (!Number.isFinite(value)) return "-"
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
}

type Metric = { name: string; read: (row: ScenarioRow) => number | undefined }

const METRICS: Metric[] = [
  { name: "readyMs", read: (row) => row.readyMs },
  { name: "railReadyMs", read: (row) => row.railReadyMs },
  ...PHASE_FIELDS.map((field): Metric => ({ name: field, read: (row) => row.analysis.ready[field] })),
  ...TAIL_FIELDS.map((field): Metric => ({ name: `tail.${field}`, read: (row) => row.analysis.tail[field] })),
]

function table(rows: readonly ScenarioRow[], metrics: readonly Metric[], variants: readonly string[], scenario: string) {
  const lines = [`### ${scenario}`, "", `| metric | ${variants.join(" | ")} |`, `| --- | ${variants.map(() => "---:").join(" | ")} |`]
  for (const metric of metrics) {
    const cells = variants.map((variant) => {
      const values = rows.filter((row) => row.variant === variant && row.scenario === scenario).map(metric.read).filter((value): value is number => value !== undefined)
      return values.length ? `${format(median(values))} (${values.length})` : "-"
    })
    if (cells.every((cell) => cell === "-")) continue
    lines.push(`| ${metric.name} | ${cells.join(" | ")} |`)
  }
  return lines.join("\n")
}

function merged(lists: readonly (readonly Attribution[])[], limit: number) {
  const out = new Map<string, Attribution>()
  for (const list of lists) {
    for (const entry of list) {
      const current = out.get(entry.where) ?? { where: entry.where, n: 0, ms: 0 }
      current.n += entry.n
      current.ms += entry.ms / lists.length
      out.set(entry.where, current)
    }
  }
  return [...out.values()].sort((a, b) => b.ms - a.ms).slice(0, limit)
}

function attributions(rows: readonly ScenarioRow[], variant: string, scenario: string) {
  const picked = rows.filter((row) => row.variant === variant && row.scenario === scenario)
  const top = merged(picked.map((row) => row.analysis.topSelf), 12).map((entry) => `  - ${entry.ms.toFixed(1)} ms ${entry.where}`)
  const forced = merged(picked.map((row) => row.analysis.forced), 8).map((entry) => `  - ${entry.n}× ${entry.ms.toFixed(1)} ms/run ${entry.where}`)
  const chunks = merged(picked.map((row) => row.analysis.chunks), 10).map((entry) => `  - ${entry.ms.toFixed(1)} ms ${entry.where}`)
  const longest = picked.flatMap((row) => row.analysis.longTasks.map((task) => ({ ...task, run: row.run }))).sort((a, b) => b.ms - a.ms).slice(0, 4)
  const tasks = longest.map((task) => `  - run ${task.run} +${task.atMs.toFixed(0)} ms: ${task.ms.toFixed(1)} ms → ${task.top.slice(0, 4).join("; ")}`)
  return [`#### ${variant} ${scenario}`, "- self time (mean per run):", ...top, "- forced style/layout:", ...forced, "- script compile/evaluate:", ...chunks, "- longest tasks:", ...tasks].join("\n")
}

export function report(rows: readonly ScenarioRow[], census: readonly ScenarioRow[]) {
  const variants = [...new Set(rows.map((row) => row.variant))]
  const scenarios = [...new Set(rows.map((row) => row.scenario))]
  const parts = scenarios.map((scenario) => table(rows, METRICS, variants, scenario))
  const censusMetrics = CENSUS_FIELDS.map((field): Metric => ({ name: field, read: (row) => row.census[field] }))
  if (census.length) parts.push("## Mutation census", ...scenarios.map((scenario) => table(census, censusMetrics, variants, scenario)))
  parts.push("## Attribution", ...variants.flatMap((variant) => scenarios.map((scenario) => attributions(rows, variant, scenario))))
  return parts.join("\n\n")
}
