import { appendFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dataRoot } from "./storage"
import type { PerfRecord } from "./perf-record"
import type { MetricComparison } from "./baseline-store"

/**
 * The durable experiment log.
 *
 * A baseline says what the numbers ARE; this says what was RUN. Without it the
 * only record of a measurement is a commit message — and several results from
 * this effort existed nowhere in the repo at all, which is how a measurement
 * gets repeated by someone with no way to know it was already done.
 *
 * Append-only JSONL, one line per run, TRACKED IN GIT. Every line carries the
 * commit, the emulation profile, the HOST it ran on and the stack, because a
 * number without those cannot be compared to anything later — the same flow on
 * the same code reads 3x differently on a cold container.
 *
 * `profile` and `host` are not the same fact and neither substitutes for the
 * other. The profile is emulation — a 4x CPU multiplier applied to whatever
 * silicon is underneath — so two machines running one profile label themselves
 * identically while producing numbers that differ several-fold.
 *
 * What is deliberately NOT stored here: heap snapshots, CPU profiles and
 * invalidation traces. Those run to hundreds of megabytes and version control
 * is the wrong home for them. What IS stored is the finding derived from them
 * — the retainer groups, the family deltas — because that is the part anyone
 * reads, and it is a few hundred bytes.
 */

/** The physical machine. What `profile` emulates ON, and cannot identify. */
export type HostFingerprint = {
  platform: string
  cpu: string
  cores: number
  memoryGb: number
}

/**
 * Identify the machine well enough to notice when two runs are not from one.
 *
 * Deliberately coarse: exact clock speeds and load averages vary run to run and
 * would make every line look unique. Model, core count and memory are stable
 * for a given machine and different between machines, which is the only
 * question this field has to answer.
 */
export function hostFingerprint(): HostFingerprint {
  const cpus = os.cpus()
  return {
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus[0]?.model ?? "unknown",
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  }
}

export type RunLogEntry = {
  at: string
  commit?: string
  lane: string
  flow: string
  profile: string
  /** Absent on lines written before the host was recorded — unknown, not equal. */
  host?: HostFingerprint
  stack: string
  /** Headline values, one per metric in the portable vocabulary. */
  metrics: Record<string, number | null>
  /** Movement against the tracked baseline, when there was one. */
  verdicts?: Record<string, string>
  /**
   * Findings distilled from artifacts too large to keep: top heap retainers,
   * query-family growth, the worst style/layout invalidation sources.
   */
  evidence?: Record<string, unknown>
  /** Free text for a result the numbers alone would misrepresent. */
  note?: string
}

export function runLogPath(lane: string) {
  return path.join(dataRoot, "runs", `${lane}.jsonl`)
}

/**
 * Append one run.
 *
 * Never throws: a measurement that completed must not be lost because its
 * bookkeeping failed, and a harness that dies while writing its own log is
 * worse than one that quietly skips a line.
 */
export async function appendRunLog(entry: RunLogEntry) {
  try {
    const file = runLogPath(entry.lane)
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(entry)}\n`)
    return file
  } catch (error) {
    console.warn(`[perf] run log skipped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Build an entry from the portable records plus whatever the lane derived. */
export function runLogEntry(input: {
  records: readonly PerfRecord[]
  comparison?: readonly MetricComparison[]
  commit?: string
  at: string
  evidence?: Record<string, unknown>
  note?: string
}): RunLogEntry | undefined {
  const first = input.records[0]
  if (!first) return undefined
  return {
    at: input.at,
    ...(input.commit ? { commit: input.commit } : {}),
    lane: first.lane,
    flow: first.flow,
    profile: first.profile,
    host: hostFingerprint(),
    stack: first.stack,
    // `null` rather than omitted: a metric the stack could not supply is a
    // fact about the run, and dropping it makes an absent metric look like one
    // that was never part of the vocabulary.
    metrics: Object.fromEntries(input.records.map((record) => [record.metric, record.value ?? null])),
    ...(input.comparison?.length
      ? { verdicts: Object.fromEntries(input.comparison.map((item) => [item.metric, item.verdict])) }
      : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.note ? { note: input.note } : {}),
  }
}
