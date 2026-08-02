import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"
import { execFile } from "node:child_process"
import { cpus } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { processIdentity, validPid } from "./process-identity"
import type { DiagnosticsObservation } from "./profiler"

export type WslRoot = {
  handshakeId: string
  pid: number
  startTicks: string
  ownerId: string
  label: string
  launchId: string
  ownerKind?: LocalDiagnostics.OwnerKind
  role?: LocalDiagnostics.ProcessRole
}

export type WslSample = {
  pid: number
  ppid: number
  rootPid: number
  startTicks: string
  cpuMachinePercent?: number
  rssBytes?: number
}

export type WslDiagnosticsSource = {
  statuses(): LocalDiagnostics.SourceStatus[]
  registerRoot(root: WslRoot): () => void
  requestCollection(at: number): void
  drain(at: number): DiagnosticsObservation[]
  dispose(): void
}

export function createWslSource(options: {
  enabled: boolean
  collect?: (roots: WslRoot[]) => Promise<WslSample[]>
}): WslDiagnosticsSource {
  const roots = new Map<string, WslRoot>()
  const last = new Map<number, DiagnosticsObservation>()
  const pending = new Map<number, DiagnosticsObservation>()
  let inFlight = false
  let disposed = false
  let status: LocalDiagnostics.SourceStatus = options.enabled
    ? { ...statusBase(), state: "warming-up" }
    : { ...statusBase(), accuracy: "unsupported", state: "unsupported", reason: "unsupported" }

  return {
    statuses: () => [status],
    registerRoot(root) {
      if (!options.enabled || !validRoot(root)) return () => {}
      roots.set(root.handshakeId, root)
      return () => {
        if (roots.get(root.handshakeId)?.launchId !== root.launchId) return
        roots.delete(root.handshakeId)
        ;[...last.values()].forEach((observation) => {
          if (observation.owner.id !== root.ownerId) return
          last.delete(observation.process.identity.pid)
          pending.delete(observation.process.identity.pid)
        })
      }
    },
    requestCollection(at) {
      if (!options.enabled || disposed || inFlight || roots.size === 0 || !options.collect) return
      inFlight = true
      void options.collect([...roots.values()]).then(
        (samples) => {
          if (disposed) return
          const rootsByPid = new Map([...roots.values()].map((root) => [root.pid, root]))
          const live = new Set<number>()
          samples.slice(0, 512).forEach((sample) => {
            const root = rootsByPid.get(sample.rootPid)
            if (!root || !validSample(sample)) return
            const observation = observe(root, sample, at)
            live.add(sample.pid)
            last.set(sample.pid, observation)
            pending.set(sample.pid, observation)
          })
          last.forEach((_, pid) => {
            if (live.has(pid)) return
            last.delete(pid)
            pending.delete(pid)
          })
          status = { ...statusBase(), state: "healthy", lastSuccessAt: at }
          inFlight = false
        },
        () => {
          if (disposed) return
          status = {
            ...statusBase(),
            state: "degraded",
            reason: "source-failed",
            ...("lastSuccessAt" in status && status.lastSuccessAt !== undefined
              ? { lastSuccessAt: status.lastSuccessAt }
              : {}),
          }
          inFlight = false
        },
      )
    },
    drain(at) {
      return [...last.entries()].map(([pid, observation]) => {
        const fresh = pending.get(pid)
        pending.delete(pid)
        if (fresh) return { ...fresh, point: { ...fresh.point, at } }
        return {
          ...observation,
          point: {
            at,
            processId: observation.point.processId,
            cpuMachinePercent: { state: "unavailable", reason: "not-sampled" },
            rssBytes: { state: "unavailable", reason: "not-sampled" },
          },
        }
      })
    },
    dispose() {
      disposed = true
      roots.clear()
      last.clear()
      pending.clear()
    },
  }
}

export function createWindowsWslCollector(systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`) {
  const run = promisify(execFile)
  const history = new Map<number, { ticks: number; at: number; startTicks: string }>()
  const logicalProcessors = Math.max(1, cpus().length)
  const script =
    'pages=$(getconf PAGESIZE); hz=$(getconf CLK_TCK); for root in "$@"; do queue="$root"; seen=" "; while [ -n "$queue" ]; do set -- $queue; p=$1; shift; queue="$*"; case "$seen" in *" $p "*) continue;; esac; seen="$seen$p "; s=$(cat "/proc/$p/stat" 2>/dev/null) || continue; rest=${s##*) }; set -- $rest; echo "$p $2 $20 $(($12+$13)) $22 $pages $hz"; children=$(cat "/proc/$p/task/$p/children" 2>/dev/null); queue="$queue $children"; done; done'
  return async (roots: WslRoot[]): Promise<WslSample[]> => {
    const pids = [...new Set(roots.map((root) => root.pid))].filter(validPid).slice(0, 512)
    if (pids.length === 0) return []
    const at = performance.now()
    const result = await run(
      join(systemRoot, "System32", "wsl.exe"),
      ["--exec", "/bin/sh", "-c", script, "claxedo-diagnostics", ...pids.map(String)],
      {
        cwd: join(systemRoot, "Temp"),
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}` },
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      },
    )
    return mapWslSnapshot(result.stdout, roots, at, logicalProcessors, history)
  }
}

export function mapWslSnapshot(
  stdout: string,
  roots: WslRoot[],
  at: number,
  logicalProcessors: number,
  history = new Map<number, { ticks: number; at: number; startTicks: string }>(),
): WslSample[] {
  const rows = stdout
    .split(/\r?\n/)
    .slice(0, 4_096)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 7 || !fields.every((field) => /^\d+$/.test(field))) return []
      const [pid, ppid, startTicks, ticks, rssPages, pageSize, clockTicks] = fields
      return [
        {
          pid: Number(pid),
          ppid: Number(ppid),
          startTicks: startTicks!,
          ticks: Number(ticks),
          rssBytes: Number(rssPages) * Number(pageSize),
          clockTicks: Number(clockTicks),
        },
      ]
    })
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const byParent = Map.groupBy(rows, (row) => row.ppid)
  const samples = roots.flatMap((root) => {
    if (byPid.get(root.pid)?.startTicks !== root.startTicks) return []
    const owned: typeof rows = []
    const pending = [root.pid]
    const seen = new Set<number>()
    while (pending.length > 0 && owned.length < 512) {
      const pid = pending.shift()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const row = byPid.get(pid)
      if (!row) continue
      owned.push(row)
      ;(byParent.get(pid) ?? []).forEach((child) => pending.push(child.pid))
    }
    return owned.map((row) => {
      const currentTicks = row.ticks
      const previous = history.get(row.pid)
      history.set(row.pid, { ticks: currentTicks, at, startTicks: row.startTicks })
      const elapsed = previous ? at - previous.at : 0
      const cpuMachinePercent =
        previous && previous.startTicks === row.startTicks && currentTicks >= previous.ticks && elapsed > 0
          ? Math.min(100, ((currentTicks - previous.ticks) * 100_000) / row.clockTicks / elapsed / logicalProcessors)
          : undefined
      return {
        pid: row.pid,
        ppid: row.ppid,
        rootPid: root.pid,
        startTicks: row.startTicks,
        cpuMachinePercent,
        rssBytes: row.rssBytes,
      }
    })
  })
  const live = new Set(samples.map((sample) => sample.pid))
  history.forEach((_, pid) => {
    if (!live.has(pid)) history.delete(pid)
  })
  return samples
}

function observe(root: WslRoot, sample: WslSample, at: number): DiagnosticsObservation {
  const identity = processIdentity({
    domain: "wsl",
    pid: sample.pid,
    creation: { state: "available", value: sample.startTicks, source: "wsl" },
    ...(sample.pid === root.pid ? { launchId: root.launchId } : {}),
  })
  return {
    owner: {
      id: root.ownerId,
      kind: root.ownerKind ?? "runtime",
      label: root.label,
      launchId: root.launchId,
      access: "local",
      lifecycle: "current",
    },
    process: {
      identity,
      ownerId: root.ownerId,
      role: sample.pid === root.pid ? (root.role ?? "runtime") : "descendant",
      label: sample.pid === root.pid ? root.label : `${root.label} child`,
      lifecycle: "running",
      actionEligibility: { state: "ineligible", reason: "owner-operation-unavailable" },
    },
    point: {
      at,
      processId: identity.id,
      cpuMachinePercent:
        sample.cpuMachinePercent === undefined
          ? { state: "unavailable", reason: "warming-up" }
          : { state: "available", value: sample.cpuMachinePercent },
      rssBytes:
        sample.rssBytes === undefined
          ? { state: "unavailable", reason: "not-sampled" }
          : { state: "available", value: sample.rssBytes },
    },
  }
}

function statusBase() {
  return {
    source: "wsl" as const,
    domain: "wsl" as const,
    accuracy: "native" as const,
    capabilities: {
      cpu: true,
      rss: true,
      ancestry: true,
      creationIdentity: true,
      actionIdentity: false,
    },
  }
}

function validRoot(root: WslRoot) {
  return (
    root.handshakeId.length > 0 &&
    root.handshakeId.length <= 256 &&
    Number.isInteger(root.pid) &&
    root.pid > 0 &&
    /^\d+$/.test(root.startTicks)
  )
}

function validSample(sample: WslSample) {
  return (
    Number.isInteger(sample.pid) &&
    sample.pid > 0 &&
    Number.isInteger(sample.ppid) &&
    sample.ppid >= 0 &&
    /^\d+$/.test(sample.startTicks) &&
    (sample.cpuMachinePercent === undefined ||
      (Number.isFinite(sample.cpuMachinePercent) &&
        sample.cpuMachinePercent >= 0 &&
        sample.cpuMachinePercent <= 100)) &&
    (sample.rssBytes === undefined || (Number.isSafeInteger(sample.rssBytes) && sample.rssBytes >= 0))
  )
}
