#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Percentiles of main-thread occupancy across repeated switch-profile runs.
 *
 * A single 10-activation lane cannot answer "what is the p95 idle" — two runs of
 * the same lane produced mean idle of 43.3 ms and 18.7 ms, because the
 * distribution is bimodal rather than noisy. Percentiles only mean something
 * once the samples from many runs are pooled, which is what this does.
 *
 * It refuses to pool runs whose recorded source digest differs. Repetitions are
 * only comparable if they built the same app, and averaging across a tree that
 * moved mid-series produces a confident number describing nothing.
 */

type Occupancy = {
  windowMicros: number
  idleMicros: number
  programMicros: number
  gcMicros: number
  scriptMicros: number
  networkBlockedIdleMicros: number
  unblockedIdleMicros: number
  tailIdleMicros: number
  longestIdleRunMicros: number
  idleRunCount: number
}

type PerRun = {
  caseId: string
  lane: string
  durationMs: number
  occupancy: Occupancy
  resources: unknown[]
}

const root = path.resolve(process.argv[2] ?? ".")
const entries = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, entry.name))
  .toSorted()

type Sample = PerRun & { run: string }
const samples: Sample[] = []
const digests = new Map<string, string>()
for (const directory of entries) {
  const artifactPath = path.join(directory, "cold-profile.json")
  const artifact = await readFile(artifactPath, "utf8").then(
    (text) => JSON.parse(text) as { perRun: PerRun[]; preciseCoverage?: boolean },
    () => undefined,
  )
  if (!artifact) continue
  const digest = await readFile(path.join(directory, "src-digest.txt"), "utf8").then(
    (text) => text.trim(),
    () => "unknown",
  )
  digests.set(path.basename(directory), digest)
  for (const run of artifact.perRun) samples.push({ ...run, run: path.basename(directory) })
}

if (samples.length === 0) throw new Error(`no switch-profile artifacts under ${root}`)

/**
 * Runs are pooled only within one source digest.
 *
 * These repetitions ran against a tree another process was actively editing, so
 * "more samples" and "one population" are not the same thing. Grouping by the
 * digest recorded with each run keeps the percentiles honest: the largest
 * coherent group is reported and every other group is named rather than
 * silently averaged in.
 */
const byDigest = new Map<string, string[]>()
for (const [run, digest] of digests) {
  byDigest.set(digest, [...(byDigest.get(digest) ?? []), run])
}
const requested = process.argv.find((value) => value.startsWith("--digest="))?.slice("--digest=".length)
const groups = [...byDigest.entries()].toSorted((left, right) => right[1].length - left[1].length)
const chosen = requested ?? groups[0]![0]
console.log(`runs=${digests.size}  activations=${samples.length}  sourceGroups=${groups.length}`)
for (const [digest, runs] of groups) {
  console.log(`  ${digest === chosen ? "USING " : "      "}${digest}  ${runs.length} run(s): ${runs.join(", ")}`)
}
if (distinctDigests(digests).has("unknown")) {
  console.log("WARNING: some runs carry no source digest, so sameness of the built app is unverified.")
}
const pooled = samples.filter((item) => digests.get(item.run) === chosen)
const pooledRuns = byDigest.get(chosen) ?? []
console.log(`pooled: ${pooledRuns.length} runs, ${pooled.length} activations, digest ${chosen}`)

function distinctDigests(map: ReadonlyMap<string, string>) {
  return new Set(map.values())
}

const LANES = [
  "within-workspace-cold",
  "within-workspace-warm",
  "across-workspaces-cold",
  "across-workspaces-warm",
]

const ms = (micros: number) => micros / 1000

/** Linear interpolation between closest ranks — the same shape the latency runner reports. */
function percentile(values: readonly number[], quantile: number) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].toSorted((left, right) => left - right)
  const index = (sorted.length - 1) * quantile
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length

console.log("")
console.log("idle per activation (ms)")
console.log(
  `  ${"lane".padEnd(24)} ${"n".padStart(4)} ${"mean".padStart(7)} ${"p50".padStart(7)} ${"p75".padStart(7)} ${"p90".padStart(7)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}`,
)
for (const lane of LANES) {
  const idle = pooled.filter((item) => item.lane === lane).map((item) => ms(item.occupancy.idleMicros))
  if (idle.length === 0) continue
  const cell = (value: number) => value.toFixed(1).padStart(7)
  console.log(
    `  ${lane.padEnd(24)} ${String(idle.length).padStart(4)} ${cell(mean(idle))} ${cell(percentile(idle, 0.5))} ${cell(percentile(idle, 0.75))} ${cell(percentile(idle, 0.9))} ${cell(percentile(idle, 0.95))} ${cell(percentile(idle, 0.99))} ${cell(Math.max(...idle))}`,
  )
}

console.log("")
console.log("idle as share of the activation window (%)")
console.log(`  ${"lane".padEnd(24)} ${"mean".padStart(7)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`)
for (const lane of LANES) {
  const share = samples
    .filter((item) => item.lane === lane)
    .map((item) => (100 * item.occupancy.idleMicros) / item.occupancy.windowMicros)
  if (share.length === 0) continue
  const cell = (value: number) => value.toFixed(1).padStart(7)
  console.log(
    `  ${lane.padEnd(24)} ${cell(mean(share))} ${cell(percentile(share, 0.5))} ${cell(percentile(share, 0.95))} ${cell(Math.max(...share))}`,
  )
}

console.log("")
console.log("idle split and shape at p95")
console.log(
  `  ${"lane".padEnd(24)} ${"netIdle p95".padStart(12)} ${"freeIdle p95".padStart(13)} ${"maxRun p95".padStart(11)} ${"runs p95".padStart(9)} ${"reqs mean".padStart(10)} ${"netShare".padStart(9)}`,
)
for (const lane of LANES) {
  const lanes = pooled.filter((item) => item.lane === lane)
  if (lanes.length === 0) continue
  const net = lanes.map((item) => ms(item.occupancy.networkBlockedIdleMicros))
  const free = lanes.map((item) => ms(item.occupancy.unblockedIdleMicros))
  const totalIdle = lanes.reduce((sum, item) => sum + item.occupancy.idleMicros, 0)
  const totalNet = lanes.reduce((sum, item) => sum + item.occupancy.networkBlockedIdleMicros, 0)
  const cell = (value: number, width: number) => value.toFixed(1).padStart(width)
  console.log(
    `  ${lane.padEnd(24)} ${cell(percentile(net, 0.95), 12)} ${cell(percentile(free, 0.95), 13)} ${cell(percentile(lanes.map((item) => ms(item.occupancy.longestIdleRunMicros)), 0.95), 11)} ${cell(percentile(lanes.map((item) => item.occupancy.idleRunCount), 0.95), 9)} ${cell(mean(lanes.map((item) => item.resources.length)), 10)} ${cell(totalIdle === 0 ? 0 : (100 * totalNet) / totalIdle, 8)}%`,
  )
}

console.log("")
console.log("per-run mean idle (ms) — run-to-run spread")
console.log(`  ${"lane".padEnd(24)} ${pooledRuns.map((run) => run.replace("run-", "r").padStart(7)).join(" ")}`)
for (const lane of LANES) {
  const cells = pooledRuns.map((run) => {
    const idle = samples.filter((item) => item.lane === lane && item.run === run).map((item) => ms(item.occupancy.idleMicros))
    return (idle.length === 0 ? "-" : mean(idle).toFixed(1)).padStart(7)
  })
  console.log(`  ${lane.padEnd(24)} ${cells.join(" ")}`)
}
