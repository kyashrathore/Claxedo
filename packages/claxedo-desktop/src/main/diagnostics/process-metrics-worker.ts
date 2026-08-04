import { spawn } from "node:child_process"
import { constants, cpus, setPriority, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import {
  parseWindowsCimRow,
  windowsCpuMachinePercent,
  windowsCreationIdentity,
  type WindowsCimRow,
} from "./process-identity"

export const MAX_DIAGNOSTICS_PIDS = 512
export const WINDOWS_SNAPSHOT_LIMIT = 1_024
export const DIAGNOSTICS_COLLECTOR_TIMEOUT_MS = 5_000
/**
 * Startup grace for a CIM PowerShell worker that has never answered. Cold
 * start on the Windows release runners is ~15s (AMSI scan of the encoded
 * script, .NET + CIM provider warm-up) — three times the steady-state
 * timeout. Judging a cold child by the steady-state timeout is self-defeating:
 * the kill throws away the warm-up, the retry pays a fresh cold start, and no
 * query ever succeeds (the release smoke's stop grant then never lands). Once
 * the child produces its first line it is warm and the normal timeout applies.
 */
export const WINDOWS_CIM_COLD_START_TIMEOUT_MS = 30_000
export const DIAGNOSTICS_SYSTEM_PATH =
  process.platform === "win32" ? String.raw`C:\Windows\System32;C:\Windows` : "/usr/bin:/bin"

export type ProcessTreeEntry = {
  pid: number
  ppid: number
  rootPid: number
}

export type ProcessMetricSample = ProcessTreeEntry & {
  creation: LocalDiagnostics.CreationIdentity
  cpuMachinePercent: number | undefined
  rssBytes: number | undefined
}

export type ProcessMetricsWorker = {
  reconcile(rootPids: number[]): Promise<{ entries: ProcessTreeEntry[]; truncated: boolean }>
  sample(entries: ProcessTreeEntry[], at: number): Promise<ProcessMetricSample[]>
  probeCreation(pid: number): Promise<LocalDiagnostics.CreationIdentity>
  clear(): void
  dispose(): void
}

export function lowerDiagnosticsWorkerPriority(
  apply: (pid: number, priority: number) => void = setPriority,
) {
  try {
    apply(0, constants.priority.PRIORITY_BELOW_NORMAL)
    return true
  } catch {
    return false
  }
}

export function createIsolatedPosixProcessMetricsWorker(options: {
  platform: "darwin" | "linux"
  workerPath?: string
  requestTimeoutMs?: number
  random?: () => number
}): ProcessMetricsWorker {
  const policy = diagnosticsWorkerProcessOptions(options.platform)
  let child: ReturnType<typeof spawn> | undefined
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(reason: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let sequence = 0
  let buffer = ""
  let disposed = false
  let restartAfter = 0

  return {
    reconcile(rootPids) {
      return request("reconcile", { rootPids: boundedPids(rootPids) }) as Promise<{
        entries: ProcessTreeEntry[]
        truncated: boolean
      }>
    },
    sample(entries, at) {
      return request("sample", { entries: uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS), at }) as Promise<
        ProcessMetricSample[]
      >
    },
    probeCreation(pid) {
      return request("probeCreation", { pid }) as Promise<LocalDiagnostics.CreationIdentity>
    },
    clear() {
      if (!disposed) void request("clear", {})
    },
    dispose() {
      if (disposed) return
      disposed = true
      child?.kill()
      failAll()
    },
  }

  function request(method: string, input: object) {
    if (disposed || Date.now() < restartAfter) return Promise.reject(new Error("process metrics worker unavailable"))
    ensureChild()
    if (!child?.stdin?.writable) return Promise.reject(new Error("process metrics worker unavailable"))
    const id = ++sequence
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        timer: setTimeout(() => timeout(id), options.requestTimeoutMs ?? DIAGNOSTICS_COLLECTOR_TIMEOUT_MS),
      })
      child!.stdin!.write(`${JSON.stringify({ id, method, ...input })}\n`)
    })
  }

  function failAll() {
    pending.forEach((request) => {
      clearTimeout(request.timer)
      request.reject(new Error("process metrics worker unavailable"))
    })
    pending.clear()
  }

  function timeout(id: number) {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    clearTimeout(request.timer)
    request.reject(new Error("process metrics worker timed out"))
    restartAfter = Date.now() + 1_000 + Math.floor((options.random?.() ?? Math.random()) * 250)
    const current = child
    child = undefined
    current?.kill()
    failAll()
  }

  function ensureChild() {
    if (child && child.exitCode === null) return
    child = spawn(process.execPath, [options.workerPath ?? join(import.meta.dirname, "process-metrics-worker.js")], {
      cwd: policy.cwd,
      env: {
        ...policy.env,
        ELECTRON_RUN_AS_NODE: "1",
        CLAXEDO_DIAGNOSTICS_WORKER_PLATFORM: options.platform,
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk
      if (buffer.length > 4 * 1024 * 1024) {
        const current = child
        child = undefined
        buffer = ""
        restartAfter = Date.now() + 1_000
        current?.kill()
        failAll()
        return
      }
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      lines.forEach((line) => {
        try {
          const envelope = JSON.parse(line) as { id?: unknown; ok?: unknown; value?: unknown }
          if (!Number.isInteger(envelope.id)) return
          const request = pending.get(envelope.id as number)
          if (!request) return
          pending.delete(envelope.id as number)
          clearTimeout(request.timer)
          if (envelope.ok === true) {
            request.resolve(envelope.value)
            return
          }
          request.reject(new Error("process metrics worker failed"))
        } catch {
          failAll()
        }
      })
    })
    const recover = () => {
      child = undefined
      buffer = ""
      restartAfter = Date.now() + 1_000
      failAll()
    }
    child.once("exit", recover)
    child.once("error", recover)
  }
}

export type WindowsAncestryAddon = {
  ProcessDataFlag: { None: number }
  getAllProcesses(
    callback: (
      rows: Array<{ pid: number; ppid: number; name?: string; memory?: number; commandLine?: string }>,
    ) => void,
    flags: number,
  ): void
  getProcessCpuUsage?: unknown
  getProcessList?: unknown
}

export async function collectWindowsAncestry(
  addon: WindowsAncestryAddon,
  rootPids: number[],
  timeoutMs = DIAGNOSTICS_COLLECTOR_TIMEOUT_MS,
) {
  const all = await new Promise<Array<{ pid: number; ppid: number }>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Windows ancestry timed out")),
      timeoutMs,
    )
    addon.getAllProcesses(
      (rows) => {
        clearTimeout(timer)
        resolve(rows.map((row) => ({ pid: row.pid, ppid: row.ppid })))
      },
      addon.ProcessDataFlag.None,
    )
  })
  return {
    entries: ownedClosure(all, boundedPids(rootPids)).slice(0, MAX_DIAGNOSTICS_PIDS),
    truncated: all.length >= WINDOWS_SNAPSHOT_LIMIT,
  }
}

export function createWindowsProcessMetricsWorker(options: {
  /**
   * Optional: the @vscode/windows-process-tree native addon is an
   * optionalDependency whose build bun may skip. Absent, `reconcile`
   * reports an empty (truncated) ancestry and CPU/RSS sampling via the CIM
   * query continues unaffected.
   */
  addon?: WindowsAncestryAddon
  query(rows: number[]): Promise<unknown[]>
  logicalProcessors?: number
  monotonicNow?: () => number
}): ProcessMetricsWorker {
  const logicalProcessors = options.logicalProcessors ?? Math.max(1, cpus().length)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const history = new Map<number, { row: WindowsCimRow; at: number }>()
  let disposed = false

  return {
    async reconcile(rootPids) {
      if (disposed) return { entries: [], truncated: false }
      // No addon → no DESCENDANT sweep, but still report the roots: `entries`
      // is the set the caller samples, so returning nothing blinds the whole
      // source (no process ever reaches a snapshot, and every owner looks
      // unregistered). Roots-only with truncated:true is the honest degrade —
      // the tree is incomplete, not absent.
      if (!options.addon) {
        return {
          entries: rootPids.map((pid) => ({ pid, ppid: 0, rootPid: pid })),
          truncated: true,
        }
      }
      return collectWindowsAncestry(options.addon, rootPids)
    },
    async sample(entries) {
      if (disposed) return []
      const selected = uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS)
      const selectedPids = new Set(selected.map((entry) => entry.pid))
      history.forEach((_, pid) => {
        if (!selectedPids.has(pid)) history.delete(pid)
      })
      const raw = await options.query(selected.map((entry) => entry.pid))
      const byPid = new Map(selected.map((entry) => [entry.pid, entry]))
      const sampledAt = monotonicNow()
      return raw.slice(0, MAX_DIAGNOSTICS_PIDS).flatMap((value) => {
        const row = parseWindowsCimRow(value)
        const entry = row ? byPid.get(row.pid) : undefined
        if (!row || !entry || row.rssBytes > BigInt(Number.MAX_SAFE_INTEGER)) return []
        const previous = history.get(row.pid)
        history.set(row.pid, { row, at: sampledAt })
        const cpu = windowsCpuMachinePercent({
          previous: previous?.row,
          current: row,
          elapsedMs: previous ? sampledAt - previous.at : 0,
          logicalProcessors,
        })
        return [
          {
            ...entry,
            creation: windowsCreationIdentity(row),
            cpuMachinePercent: cpu.state === "available" ? cpu.value : undefined,
            rssBytes: Number(row.rssBytes),
          },
        ]
      })
    },
    async probeCreation(pid) {
      if (disposed || !Number.isInteger(pid) || pid <= 0) {
        return { state: "unavailable", reason: "identity-unavailable" }
      }
      const row = (await options.query([pid])).map(parseWindowsCimRow).find((value) => value?.pid === pid)
      return row ? windowsCreationIdentity(row) : { state: "unavailable", reason: "identity-unavailable" }
    },
    clear() {
      history.clear()
    },
    dispose() {
      disposed = true
      history.clear()
    },
  }
}

export function diagnosticsWorkerProcessOptions(platform: NodeJS.Platform, systemRoot = String.raw`C:\Windows`) {
  const windows = platform === "win32"
  return {
    executable: windows
      ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : platform === "darwin"
        ? "/bin/ps"
        : "/usr/bin/ps",
    cwd: windows ? join(systemRoot, "Temp") : tmpdir(),
    env: windows
      ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}` }
      : { PATH: DIAGNOSTICS_SYSTEM_PATH, LANG: "C", LC_ALL: "C" },
  }
}

export function windowsCimCommand(encodedCommand: string, systemRoot = String.raw`C:\Windows`) {
  const policy = diagnosticsWorkerProcessOptions("win32", systemRoot)
  return {
    ...policy,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
  }
}

export function spawnWindowsCimWorker(encodedCommand: string, systemRoot = String.raw`C:\Windows`) {
  const command = windowsCimCommand(encodedCommand, systemRoot)
  return spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  })
}

export type WindowsCimWorkerChild = {
  stdin: { writable: boolean; write(chunk: string): unknown } | null
  stdout: NodeJS.ReadableStream
  exitCode: number | null
  kill(signal?: string | number): unknown
  once(event: "exit" | "error", listener: () => void): unknown
}

export function createWindowsCimQuery(
  encodedCommand: string,
  systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`,
  timeoutMs = DIAGNOSTICS_COLLECTOR_TIMEOUT_MS,
  coldStartTimeoutMs = WINDOWS_CIM_COLD_START_TIMEOUT_MS,
  spawnWorker: (encodedCommand: string, systemRoot: string) => WindowsCimWorkerChild = spawnWindowsCimWorker,
) {
  let child: WindowsCimWorkerChild | undefined
  let childWarmed = false
  let lines: ReturnType<typeof createInterface> | undefined
  let restartAfter = 0
  const pending: Array<{
    resolve(rows: unknown[]): void
    reject(reason: Error): void
    timer: ReturnType<typeof setTimeout>
  }> = []

  return {
    query(pids: number[]) {
      const selected = boundedPids(pids)
      if (selected.length === 0) return Promise.resolve([])
      if (Date.now() < restartAfter) return Promise.reject(new Error("Windows metrics source is recovering"))
      ensureChild()
      if (!child?.stdin?.writable) return Promise.reject(new Error("Windows metrics source unavailable"))
      return new Promise<unknown[]>((resolve, reject) => {
        const request = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = pending.indexOf(request)
            if (index >= 0) pending.splice(index, 1)
            reject(new Error("Windows metrics source timed out"))
            child?.kill()
            recover()
          }, childWarmed ? timeoutMs : coldStartTimeoutMs),
        }
        pending.push(request)
        child!.stdin!.write(`${JSON.stringify(selected)}\n`)
      })
    },
    dispose() {
      lines?.close()
      child?.kill()
      fail()
    },
  }

  function ensureChild() {
    if (child && child.exitCode === null) return
    child = spawnWorker(encodedCommand, systemRoot)
    childWarmed = false
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on("line", (line) => {
      childWarmed = true
      const request = pending.shift()
      if (!request) return
      clearTimeout(request.timer)
      try {
        const envelope = JSON.parse(line) as { ok?: unknown; rows?: unknown }
        if (envelope.ok !== true || !Array.isArray(envelope.rows) || envelope.rows.length > MAX_DIAGNOSTICS_PIDS) {
          request.reject(new Error("Windows metrics response rejected"))
          return
        }
        request.resolve(envelope.rows)
      } catch {
        request.reject(new Error("Windows metrics response rejected"))
      }
    })
    child.once("exit", recover)
    child.once("error", recover)
  }

  function recover() {
    restartAfter = Date.now() + 1_000
    child = undefined
    lines = undefined
    fail()
  }

  function fail() {
    pending.splice(0).forEach((request) => {
      clearTimeout(request.timer)
      request.reject(new Error("Windows metrics source unavailable"))
    })
  }
}

export function boundedPids(pids: number[]) {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff))].slice(
    0,
    MAX_DIAGNOSTICS_PIDS,
  )
}

export function uniqueEntries(entries: ProcessTreeEntry[]) {
  return [...new Map(entries.map((entry) => [entry.pid, entry])).values()]
}

function ownedClosure(rows: Array<{ pid: number; ppid: number }>, rootPids: number[]) {
  const byParent = Map.groupBy(
    rows.filter((row) => Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.ppid) && row.ppid >= 0),
    (row) => row.ppid,
  )
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const entries: ProcessTreeEntry[] = []
  rootPids.forEach((rootPid) => {
    const pending = [rootPid]
    const seen = new Set<number>()
    while (pending.length > 0 && entries.length < MAX_DIAGNOSTICS_PIDS) {
      const pid = pending.shift()!
      if (seen.has(pid)) continue
      seen.add(pid)
      const row = byPid.get(pid)
      entries.push({ pid, ppid: row?.ppid ?? 0, rootPid })
      ;(byParent.get(pid) ?? []).forEach((child) => pending.push(child.pid))
    }
  })
  return uniqueEntries(entries)
}
