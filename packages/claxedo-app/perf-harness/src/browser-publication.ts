import { compareToBaseline, readBaselineFor, writeBaselineFor } from "./baseline-store"
import { browserRecords } from "./browser-records"
import type { FrameMetric } from "./frame-sampler"
import type { AuthoritativeSourceIdentity } from "./measurement-provenance"
import { appendRunLog, runLogEntry } from "./run-log"
import type { RunOptions, ScenarioResult } from "./types"

type PublicationSource = { sourceIdentity: AuthoritativeSourceIdentity; sourceStable: boolean }

function invalidRendererMeasurement(headline: FrameMetric) {
  return !Number.isSafeInteger(headline.sampleCount) || headline.sampleCount < 1 ||
    ![headline.completionMs, headline.worstFrameMs, headline.p95FrameMs].every((value) => Number.isFinite(value) && value >= 0) ||
    !["renderer-task-v1", "renderer-interval-v1"].includes(headline.method ?? "")
}

export function browserPublication(result: ScenarioResult, valid: boolean, source?: PublicationSource) {
  if (!valid) return { allowed: false, invalid: true, reason: "scenario evidence is invalid" }
  if (source && !source.sourceStable) return { allowed: false, invalid: true, reason: "source or artifact changed during build or measurement" }
  const repetitions = result.repetitions ?? [{ headline: result.headline }]
  if (!repetitions.length || invalidRendererMeasurement(result.headline) ||
    repetitions.some((run) => invalidRendererMeasurement(run.headline)) ||
    new Set([result.headline.method, ...repetitions.map((run) => run.headline.method)]).size !== 1) {
    return { allowed: false, invalid: true, reason: "renderer repetitions are empty, invalid, or use incompatible measurement methods" }
  }
  if (result.context?.suite === "diagnostics") {
    const controls = result.diagnostics?.controlRepetitions
    if (!controls?.length || controls.some((run) => invalidRendererMeasurement(run.headline)) ||
      new Set([result.headline.method, ...controls.map((run) => run.headline.method)]).size !== 1) {
      return { allowed: false, invalid: true, reason: "diagnostics control repetitions are empty, invalid, or use incompatible measurement methods" }
    }
  }
  if (result.status === "fail") return { allowed: false, reason: "scenario failed acceptance" }
  if (!result.context || result.context.suite === "attribution") return { allowed: false, reason: "run is not a comparable measurement" }
  if (result.context.suite === "diagnostics" && result.warnings.some((warning) => warning.includes("disabled control base-app gate"))) {
    return { allowed: false, reason: "diagnostics control failed the base-app gate" }
  }
  return { allowed: true }
}

/** One publication boundary for browser baselines and durable comparisons. Raw reports are always retained. */
export async function publishBrowserResult(result: ScenarioResult, options: Pick<RunOptions, "stack" | "accept_baseline" | "append_trend">, valid: boolean, source: PublicationSource) {
  const policy = browserPublication(result, valid, source)
  if (!policy.allowed) {
    if (policy.invalid || options.accept_baseline) {
      result.status = "fail"
      result.failures.push(`${options.accept_baseline ? "Baseline" : "Measurement"} refused: ${policy.reason}`)
    }
    return
  }
  const records = browserRecords(result, options.stack)
  if (records.some((record) => (record.value !== undefined && !Number.isFinite(record.value)) ||
    record.samples.some((value) => !Number.isFinite(value)))) {
    result.status = "fail"
    result.failures.push("Measurement refused: non-finite metric value or repetition")
    return
  }
  const baseline = await readBaselineFor({ profile: records[0].profile, stack: options.stack, lane: "browser", flow: result.id, suite: result.context!.suite })
  result.comparison = compareToBaseline(records, baseline)
  const commit = source.sourceIdentity.mode === "git" ? source.sourceIdentity.commit : undefined
  if (options.accept_baseline) await writeBaselineFor(records, commit, source.sourceIdentity)
  const entry = runLogEntry({
    records, comparison: result.comparison, commit, sourceIdentity: source.sourceIdentity, at: result.started_at,
    evidence: { status: result.status, warnings: result.warnings },
  })
  if (entry && options.append_trend) await appendRunLog(entry)
}
