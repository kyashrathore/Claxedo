import path from "node:path"
import { dataRoot, readJson, writeJson } from "./storage"
import { METRICS, type PerfRecord } from "./perf-record"
import type { AuthoritativeSourceIdentity } from "./memory-provenance"

/**
 * Committed baselines, and the comparison an experiment is judged by.
 *
 * Baselines live under `data/baselines/<profile>/<stack>/<lane>/<flow>.json` and
 * are TRACKED IN GIT. That is the difference between a baseline and a scratch
 * file: an untracked one is derived from whichever machine happened to run
 * first, so two people — or the same person on two days — cannot compare
 * anything. The path is keyed by profile AND stack precisely so the two can
 * never be silently mixed; comparing a throttled run to an unthrottled one, or
 * Solid 2 to Solid 1 on different hardware, has to be impossible by
 * construction rather than by remembering.
 */

export type Baseline = {
  profile: string
  stack: string
  lane: string
  flow: string
  accepted_at: string
  commit?: string
  /** Exact source authority that produced this baseline; absent only on legacy files. */
  sourceIdentity?: AuthoritativeSourceIdentity
  metrics: Record<string, { value?: number; samples: number[]; absentReason?: string }>
}

/** The commit a baseline describes, so a move can be attributed to a change. */
export function currentCommit() {
  try {
    return Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

export function baselineFile(input: { profile: string; stack: string; lane: string; flow: string }) {
  return path.join(dataRoot, "baselines", input.profile, input.stack, input.lane, `${input.flow}.json`)
}

export async function readBaselineFor(input: { profile: string; stack: string; lane: string; flow: string }) {
  return readJson<Baseline | undefined>(baselineFile(input), undefined)
}

export function baselineFromRecords(
  records: PerfRecord[],
  commit?: string,
  sourceIdentity?: AuthoritativeSourceIdentity,
) {
  const first = records[0]
  if (!first) return undefined
  const baseline: Baseline = {
    profile: first.profile,
    stack: first.stack,
    lane: first.lane,
    flow: first.flow,
    accepted_at: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    ...(sourceIdentity ? { sourceIdentity } : {}),
    metrics: Object.fromEntries(records.map((record) => [record.metric, {
      ...(record.value === undefined ? {} : { value: record.value }),
      samples: record.samples,
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
  verdict: "improved" | "regressed" | "unchanged" | "absent" | "new"
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
    if (record.value === undefined || previous?.value === undefined) {
      return {
        ...base,
        baseline: previous?.value,
        current: record.value,
        verdict: (previous ? "absent" : "new") as MetricComparison["verdict"],
      }
    }
    const deltaPct = ((record.value - previous.value) / previous.value) * 100
    const direction = METRICS[record.metric]?.direction ?? "lower"
    const moved = Math.abs(deltaPct) > tolerance * 100
    const better = direction === "lower" ? deltaPct < 0 : deltaPct > 0
    return {
      ...base,
      baseline: previous.value,
      current: record.value,
      deltaPct,
      verdict: !moved ? "unchanged" : better ? "improved" : "regressed",
    }
  })
}
