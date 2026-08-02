import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import type { Baseline, Budget, ScenarioId, ScenarioResult, TrendRecord } from "./types"

export const harnessRoot = path.resolve(import.meta.dirname, "..")
export const appRoot = path.resolve(harnessRoot, "..")
export const repoRoot = path.resolve(harnessRoot, "../../..")
export const dataRoot = path.join(harnessRoot, "data")
export const reportsRoot = path.join(harnessRoot, "reports")

// How much slower than the first accepted run the headline worst-frame may drift
// before we call it a regression. The absolute 8.33/16.67 thresholds are enforced
// separately in report.ts; this budget catches "still passing but 2x slower".
const REGRESSION_HEADROOM = 1.5

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!(await Bun.file(file).exists())) return fallback
  return Bun.file(file).json() as Promise<T>
}

export async function writeJson(file: string, value: unknown) {
  await Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function budgetPath(scenario: ScenarioId) {
  return path.join(dataRoot, "budgets", `${scenario}.json`)
}

export function baselinePath(scenario: ScenarioId) {
  return path.join(dataRoot, "baselines", `${scenario}.json`)
}

export function trendPath(scenario: ScenarioId) {
  return path.join(dataRoot, "trends", `${scenario}.jsonl`)
}

export async function ensureBudget(result: Pick<ScenarioResult, "id" | "headline">): Promise<Budget> {
  const file = budgetPath(result.id)
  const existing = await readJson<Budget | undefined>(file, undefined)
  if (existing && typeof existing.worst_frame_ms === "number" && Number.isFinite(existing.worst_frame_ms)) {
    return existing
  }
  const budget: Budget = {
    scenario: result.id,
    worst_frame_ms: Math.ceil(result.headline.worstFrameMs * REGRESSION_HEADROOM),
  }
  await writeJson(file, budget)
  return budget
}

export async function readBaseline(scenario: ScenarioId) {
  return readJson<Baseline | undefined>(baselinePath(scenario), undefined)
}

export async function writeBaseline(result: ScenarioResult) {
  await writeJson(baselinePath(result.id), {
    scenario: result.id,
    accepted_at: new Date().toISOString(),
    worst_frame_ms: result.headline.worstFrameMs,
    p95_frame_ms: result.headline.p95FrameMs,
  } satisfies Baseline)
}

export async function appendTrend(result: ScenarioResult) {
  if (result.status === "fail") return
  const file = trendPath(result.id)
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(
    file,
    `${JSON.stringify({
      scenario: result.id,
      recorded_at: new Date().toISOString(),
      status: result.status,
      seed: result.seed,
      attribution: result.attribution,
      worst_frame_ms: result.headline.worstFrameMs,
      p95_frame_ms: result.headline.p95FrameMs,
      verdict: result.headline.verdict,
    } satisfies TrendRecord)}\n`,
  )
}
