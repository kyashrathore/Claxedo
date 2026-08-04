import { cpus } from "node:os"
import { readFile } from "node:fs/promises"

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
  MAX_DIAGNOSTICS_PIDS,
  type ProcessMetricSample,
  type ProcessMetricsWorker,
  type ProcessTreeEntry,
  uniqueEntries,
} from "./process-metrics-worker"

const packageUsage = packageUsageModule as unknown as Pidusage

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
  usage?: Pidusage
  tree?: typeof pidtree
}): ProcessMetricsWorker {
  const usage = options.usage ?? packageUsage
  const tree = options.tree ?? pidtree
  const logicalProcessors = options.logicalProcessors ?? Math.max(1, cpus().length)
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
    async sample(entries) {
      if (disposed) return []
      const bounded = uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS)
      if (bounded.length === 0) return []
      const stats = await resilientUsage(
        usage,
        bounded.map((entry) => entry.pid),
        options.platform === "darwin",
      )
      if (Object.keys(stats).length === 0) throw new Error("process metrics sampling failed")
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
    },
    dispose() {
      disposed = true
      usage.clear()
    },
  }
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
