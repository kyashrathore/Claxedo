import path from "node:path"
import { contextKey, evidenceMatches, type MeasurementEvidence } from "./measurement-context"
import { dataRoot, readJson, writeJson } from "./storage"
import { METRICS, type PerfRecord } from "./perf-record"
import type { AuthoritativeSourceIdentity } from "./measurement-provenance"

/** Accepted measurements live under profile/stack/lane/suite/flow paths.
 * Comparisons additionally require matching metric evidence; path identity alone
 * cannot distinguish different hosts, workloads or measurement methods.
 */

export type Baseline = {
  profile: string
  stack: string
  lane: string
  flow: string
  suite: string
  accepted_at: string
  commit?: string
  /** Exact source authority that produced this baseline; absent only on legacy files. */
  sourceIdentity?: AuthoritativeSourceIdentity
  metrics: Record<string, { value?: number; samples: number[]; absentReason?: string; evidence?: MeasurementEvidence }>
}

export function baselineFile(input: { profile: string; stack: string; lane: string; flow: string; suite: string }) {
  return path.join(dataRoot, "baselines", input.profile, input.stack, input.lane, input.suite, `${input.flow}.json`)
}

export async function readBaselineFor(input: { profile: string; stack: string; lane: string; flow: string; suite: string }) {
  return readJson<Baseline | undefined>(baselineFile(input), undefined)
}

export function baselineFromRecords(
  records: PerfRecord[],
  commit?: string,
  sourceIdentity?: AuthoritativeSourceIdentity,
) {
  const first = records[0]
  if (!first) return undefined
  if (records.some((record) => record.lane !== first.lane || record.flow !== first.flow || record.profile !== first.profile || record.stack !== first.stack)) {
    throw new Error("Cannot accept records from different flows or implementations")
  }
  for (const record of records) {
    if (!record.evidence || record.evidence.context.suite === "attribution") throw new Error("Cannot accept baseline without comparable measurement evidence")
    if (contextKey(record.evidence.context) !== contextKey(first.evidence!.context)) throw new Error("Cannot accept mixed measurement contexts")
    if ((record.value !== undefined && !Number.isFinite(record.value)) || record.samples.some((sample) => !Number.isFinite(sample))) throw new Error("Cannot accept non-finite baseline values")
  }
  const baseline: Baseline = {
    profile: first.profile,
    stack: first.stack,
    lane: first.lane,
    flow: first.flow,
    suite: first.evidence!.context.suite,
    accepted_at: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    ...(sourceIdentity ? { sourceIdentity } : {}),
    metrics: Object.fromEntries(records.map((record) => [record.metric, {
      ...(record.value === undefined ? {} : { value: record.value }),
      samples: record.samples,
      evidence: record.evidence,
      ...(record.absentReason ? { absentReason: record.absentReason } : {}),
    }])),
  }
  return baseline
}

export async function writeBaselineFor(
  records: PerfRecord[],
  commit?: string,
  sourceIdentity?: AuthoritativeSourceIdentity,
) {
  const baseline = baselineFromRecords(records, commit, sourceIdentity)
  if (!baseline) return undefined
  await writeJson(baselineFile(baseline), baseline)
  return baseline
}

/**
 * Relative tolerance for "this did not really move".
 *
 * Derived from the baseline's OWN samples rather than a fixed percentage,
 * because the honest tolerance differs per metric and per machine: a flow whose
 * worst frame swings 3x between identical runs cannot detect a 10% change, and
 * pretending otherwise is how a rewrite gets declared a win. Two standard
 * deviations of the baseline's observed spread, floored at 5% so a
 * suspiciously quiet baseline does not produce a hair trigger.
 *
 * Samples must be repeated measurements OF THE METRIC — one per run — not the
 * distribution underneath it. Feeding in every main-thread task rather than
 * each run's worst produced a ±1787% tolerance, a band no regression could
 * ever escape.
 *
 * Stated limitation: a baseline accepted from a single run has n=1, so this
 * falls back to a flat 15%, which on a machine with ~3x run-to-run spread is
 * optimistic. It is a guard against over-claiming, not a significance test.
 * Accept a baseline over several runs (`--iterations`) before trusting a
 * close call, and treat a first-run baseline as provisional.
 */
export function toleranceFor(samples: readonly number[]) {
  if (samples.length < 2) return 0.15
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  if (mean === 0) return 0.15
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
  const relStdDev = Math.sqrt(variance) / Math.abs(mean)
  return Math.max(0.05, relStdDev * 2)
}

export type MetricComparison = {
  metric: string
  baseline?: number
  current?: number
  deltaPct?: number
  tolerancePct: number
  reason?: string
  verdict: "improved" | "regressed" | "unchanged" | "absent" | "new" | "incompatible"
}

/**
 * Compare one flow's records against its baseline.
 *
 * `absent` propagates rather than scoring: a stack that cannot report a metric
 * has not improved it. That case is the whole reason an experiment lane needs
 * this — a native port will legitimately have no `visual_stability`, and
 * silently treating it as 0 would show the port winning a metric it never
 * measured.
 */
export function compareToBaseline(records: readonly PerfRecord[], baseline: Baseline | undefined): MetricComparison[] {
  return records.map((record) => {
    const previous = baseline?.metrics[record.metric]
    const tolerance = toleranceFor(previous?.samples ?? record.samples)
    const base = { metric: record.metric, tolerancePct: tolerance * 100 }
    if (previous && (!baseline || baseline.profile !== record.profile || baseline.stack !== record.stack || baseline.lane !== record.lane || baseline.flow !== record.flow || !evidenceMatches(record.evidence, previous.evidence))) {
      return { ...base, baseline: previous.value, current: record.value, verdict: "incompatible", reason: "measurement definition, method, host, workload, environment or suite differs or is unknown" }
    }
    if (record.value === undefined || previous?.value === undefined) {
      return {
        ...base,
        baseline: previous?.value,
        current: record.value,
        verdict: (previous ? "absent" : "new") as MetricComparison["verdict"],
      }
    }
    if (!Number.isFinite(record.value) || !Number.isFinite(previous.value)) {
      return { ...base, verdict: "incompatible", reason: "non-finite measurement" }
    }
    const deltaPct = previous.value === 0 ? (record.value === 0 ? 0 : undefined) : ((record.value - previous.value) / Math.abs(previous.value)) * 100
    const direction = METRICS[record.metric]?.direction ?? "lower"
    const moved = deltaPct === undefined || Math.abs(deltaPct) > tolerance * 100
    const better = direction === "lower" ? record.value < previous.value : record.value > previous.value
    return {
      ...base,
      baseline: previous.value,
      current: record.value,
      deltaPct,
      verdict: !moved ? "unchanged" : better ? "improved" : "regressed",
    }
  })
}
