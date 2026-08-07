import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { cpus } from "node:os"
import { promisify } from "node:util"

import pidtree from "pidtree"
// Static import, NOT createRequire: the worker entry is bundled with
// externalizeDeps:false and the packaged app ships no node_modules beyond
// native modules — a runtime require() is invisible to the bundler, stayed
// external, and made every packaged POSIX metrics sample die with "Cannot
// find module 'pidusage'" (macos-ps degraded source-failed in the packaged
// diagnostics smoke). pidusage is pure JS, so bundling it is safe.
// @ts-expect-error pidusage ships no types; the local Pidusage type below is
// the reviewed contract for the slice of its API this worker uses.
import packageUsageModule from "pidusage"

import { linuxCreationIdentity } from "./process-identity"
import {
  boundedPids,
  diagnosticsWorkerProcessOptions,
  MAX_DIAGNOSTICS_PIDS,
  type ProcessMetricSample,
  type ProcessMetricsWorker,
  type ProcessTreeEntry,
  uniqueEntries,
} from "./process-metrics-worker"

const packageUsage = packageUsageModule as unknown as Pidusage
const execFileAsync = promisify(execFile)

type PidusageStats = {
  cpu: number
  memory: number
  pid: number
  ppid: number
}

export type Pidusage = {
  (pids: number[], options: { maxage: number; usePs?: boolean }): Promise<Record<number, PidusageStats>>
  clear(): void
}

export function createPosixProcessMetricsWorker(options: {
  platform: "darwin" | "linux"
  logicalProcessors?: number
  readLinuxStat?: (pid: number) => Promise<string>
  readLinuxSmapsRollup?: (pid: number) => Promise<string>
  readMacMemoryImpact?: (pids: number[]) => Promise<Map<number, number>>
  memoryHelperPath?: string
  memoryImpactIntervalMs?: number
  usage?: Pidusage
  tree?: typeof pidtree
}): ProcessMetricsWorker {
  const usage = options.usage ?? packageUsage
  const tree = options.tree ?? pidtree
  const logicalProcessors = options.logicalProcessors ?? Math.max(1, cpus().length)
  const memoryImpact = new Map<number, ProcessMetricSample["memoryImpact"]>()
  let nextMemoryImpactAt = Number.NEGATIVE_INFINITY
  let disposed = false

  return {
    async reconcile(rootPids) {
      if (disposed) return { entries: [], truncated: false }
      const roots = boundedPids(rootPids)
      const settled = await Promise.allSettled(
        roots.map(async (rootPid) =>
          (await tree(rootPid, { root: true, advanced: true })).map((entry) => ({
            pid: entry.pid,
            ppid: entry.ppid ?? 0,
            rootPid,
          })),
        ),
      )
      const entries = uniqueEntries(
        settled.flatMap((result, index) =>
          result.status === "fulfilled" ? result.value : [{ pid: roots[index]!, ppid: 0, rootPid: roots[index]! }],
        ),
      ).slice(0, MAX_DIAGNOSTICS_PIDS)
      if (settled.some((result) => result.status === "rejected")) {
        throw new Error("process ancestry reconciliation failed")
      }
      return {
        entries,
        truncated:
          settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).length > entries.length,
      }
    },
    async sample(entries, at) {
      if (disposed) return []
      const bounded = uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS)
      if (bounded.length === 0) return []
      const stats = await resilientUsage(
        usage,
        bounded.map((entry) => entry.pid),
        options.platform === "darwin",
      )
      if (Object.keys(stats).length === 0) throw new Error("process metrics sampling failed")
      if (at >= nextMemoryImpactAt) {
        const pids = bounded.map((entry) => entry.pid)
        const measured = options.platform === "darwin"
          ? await (options.readMacMemoryImpact
              ? options.readMacMemoryImpact(pids)
              : collectMacMemoryImpact(pids, options.memoryHelperPath))
            .then((readings) => new Map([...readings].map(([pid, bytes]) => [
              pid,
              { kind: "physical-footprint" as const, bytes },
            ])))
            .catch(() => new Map())
          : new Map((await Promise.all(pids.map(async (pid) => {
              try {
                const rollup = await (options.readLinuxSmapsRollup
                  ? options.readLinuxSmapsRollup(pid)
                  : readFile(`/proc/${String(pid)}/smaps_rollup`, "utf8"))
                const bytes = parseLinuxPssBytes(rollup)
                return bytes === undefined ? undefined : [pid, { kind: "pss" as const, bytes }] as const
              } catch {
                return
              }
            }))).filter((reading): reading is readonly [number, { kind: "pss"; bytes: number }] => !!reading))
        memoryImpact.clear()
        measured.forEach((reading, pid) => memoryImpact.set(pid, reading))
        nextMemoryImpactAt = at + (options.memoryImpactIntervalMs ?? 10_000)
      }
      return (
        await Promise.all(
          bounded.map(async (entry) => {
            const value = stats[entry.pid]
            if (!value || !Number.isFinite(value.cpu) || !Number.isFinite(value.memory)) return
            return {
              ...entry,
              creation:
                options.platform === "linux"
                  ? await readLinuxIdentity(entry.pid, options.readLinuxStat)
                  : ({ state: "unavailable", reason: "identity-unavailable" } as const),
              cpuMachinePercent: Math.min(100, Math.max(0, value.cpu / logicalProcessors)),
              rssBytes: Math.max(0, Math.trunc(value.memory)),
              memoryImpact: memoryImpact.get(entry.pid) ?? {
                kind: "rss-fallback" as const,
                bytes: Math.max(0, Math.trunc(value.memory)),
              },
            }
          }),
        )
      ).flatMap((sample) => (sample ? [sample] : []))
    },
    async probeCreation(pid) {
      if (disposed || !Number.isInteger(pid) || pid <= 0 || options.platform !== "linux") {
        return { state: "unavailable", reason: "identity-unavailable" }
      }
      return readLinuxIdentity(pid, options.readLinuxStat)
    },
    clear() {
      usage.clear()
      memoryImpact.clear()
      nextMemoryImpactAt = Number.NEGATIVE_INFINITY
    },
    dispose() {
      disposed = true
      usage.clear()
      memoryImpact.clear()
    },
  }

}

export function parseLinuxPssBytes(rollup: string) {
  const match = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup)
  if (!match) return
  const kib = Number(match[1])
  if (!Number.isSafeInteger(kib)) return
  return kib * 1_024
}

export function parseMacMemoryImpact(output: string) {
  return new Map(
    output
      .split("\n")
      .flatMap((line) => {
        const match = /^(\d+) (\d+)$/.exec(line.trim())
        if (!match) return []
        const pid = Number(match[1])
        const bytes = Number(match[2])
        return Number.isInteger(pid) && pid > 0 && Number.isSafeInteger(bytes) && bytes >= 0
          ? [[pid, bytes] as const]
          : []
      }),
  )
}

async function collectMacMemoryImpact(pids: number[], helperPath?: string) {
  if (!helperPath || pids.length === 0) return new Map<number, number>()
  const policy = diagnosticsWorkerProcessOptions("darwin")
  const result = await execFileAsync(helperPath, pids.map(String), {
    cwd: policy.cwd,
    env: policy.env,
    timeout: 2_000,
    maxBuffer: 64 * 1_024,
    encoding: "utf8",
  })
  return parseMacMemoryImpact(result.stdout)
}

async function resilientUsage(
  usage: Pidusage,
  pids: number[],
  usePs: boolean,
): Promise<Record<number, PidusageStats>> {
  try {
    return await usage(pids, { maxage: 5_000, usePs })
  } catch {
    if (pids.length <= 1) return {}
    const chunkSize = Math.max(1, Math.ceil(pids.length / 8))
    const chunks = Array.from(
      { length: Math.ceil(pids.length / chunkSize) },
      (_, index) => pids.slice(index * chunkSize, (index + 1) * chunkSize),
    )
    return Object.assign(
      {},
      ...(await Promise.allSettled(
        chunks.map((chunk) => usage(chunk, { maxage: 5_000, usePs })),
      )).flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
    )
  }
}

async function readLinuxIdentity(pid: number, read?: (pid: number) => Promise<string>) {
  try {
    return linuxCreationIdentity(await (read ? read(pid) : readFile(`/proc/${String(pid)}/stat`, "utf8")))
  } catch {
    return { state: "unavailable", reason: "identity-unavailable" } as const
  }
}
