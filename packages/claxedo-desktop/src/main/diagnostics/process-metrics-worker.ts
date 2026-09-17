import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import { constants, cpus, setPriority, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

import { readArray, readNumber, readString, readUnknown } from "../../shared/json-read"

import {
  parseWindowsCimRow,
  validPid,
  windowsCpuMachinePercent,
  windowsCreationIdentity,
  type WindowsCimRow,
} from "./process-identity"

export const MAX_DIAGNOSTICS_PIDS = 512
export const WINDOWS_SNAPSHOT_LIMIT = 1_024
export const DIAGNOSTICS_COLLECTOR_TIMEOUT_MS = 5_000
/**
 * Startup grace for a CIM PowerShell worker that has never answered. Measured
 * cold start on the Windows release runners is 22–47s per fresh powershell.exe
 * (AMSI scan of the EncodedCommand + .NET warm-up, paid on EVERY spawn — the
 * windows-cim-probe workflow has now timed it four ways, worst 46.9s). Judging
 * a cold child by the 5s steady-state timeout is self-defeating: the kill
 * throws away the warm-up, the retry pays a fresh cold start, and no query
 * ever succeeds. 90s keeps ~2x headroom over the worst OBSERVED start rather
 * than 1.3x, which is inside this runner's own spread; once the child produces
 * its first line it is warm (subsequent queries measured 2–23ms) and the
 * normal timeout applies.
 */
export const WINDOWS_CIM_COLD_START_TIMEOUT_MS = 90_000
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
  memoryImpact?: { kind: LocalDiagnostics.MemoryImpactKind; bytes: number }
}

/**
 * The worker answers over a pipe, so every reply below arrives as `unknown`.
 *
 * These are the readers for the three reply shapes. `isProcessTreeEntry` is
 * also the ENTRY-side check: `process-metrics-worker-entry.ts` used to keep a
 * private copy of it under the name `validEntry`, so the same three fields
 * were described twice and could drift apart.
 */
export function isProcessTreeEntry(value: unknown): value is ProcessTreeEntry {
  const ppid = readNumber(value, "ppid")
  return (
    validPid(readNumber(value, "pid")) &&
    ppid !== undefined &&
    Number.isInteger(ppid) &&
    ppid >= 0 &&
    validPid(readNumber(value, "rootPid"))
  )
}

function isReconcileReply(value: unknown): value is { entries: ProcessTreeEntry[]; truncated: boolean } {
  const entries = readArray(value, "entries")
  return !!entries && entries.every(isProcessTreeEntry) && typeof readUnknown(value, "truncated") === "boolean"
}

function isProcessMetricSample(value: unknown): value is ProcessMetricSample {
  if (!isProcessTreeEntry(value)) return false
  if (!LocalDiagnostics.CreationIdentity.safeParse(readUnknown(value, "creation")).success) return false
  const cpuMachinePercent = readUnknown(value, "cpuMachinePercent")
  if (cpuMachinePercent !== undefined && typeof cpuMachinePercent !== "number") return false
  const rssBytes = readUnknown(value, "rssBytes")
  if (rssBytes !== undefined && typeof rssBytes !== "number") return false
  const memoryImpact = readUnknown(value, "memoryImpact")
  if (memoryImpact === undefined) return true
  const bytes = readNumber(memoryImpact, "bytes")
  return (
    LocalDiagnostics.MemoryImpactKind.safeParse(readUnknown(memoryImpact, "kind")).success &&
    bytes !== undefined &&
    Number.isSafeInteger(bytes) &&
    bytes >= 0
  )
}

function isSampleReply(value: unknown): value is ProcessMetricSample[] {
  return Array.isArray(value) && value.every(isProcessMetricSample)
}

function isCreationIdentity(value: unknown): value is LocalDiagnostics.CreationIdentity {
  return LocalDiagnostics.CreationIdentity.safeParse(value).success
}

/** `clear` answers with no value at all. */
function isNoReply(value: unknown): value is undefined {
  return value === undefined
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
  /**
   * Defaults to `process.execPath`, which in Electron main is the app binary
   * and, with ELECTRON_RUN_AS_NODE below, Node's ESM linker. A harness that is
   * not itself Electron (the bun smoke) must pass the Electron binary here, or
   * it proves the worker under a loader with different import semantics.
   */
  execPath?: string
  requestTimeoutMs?: number
  random?: () => number
  memoryHelperPath?: string
}): ProcessMetricsWorker {
  const policy = diagnosticsWorkerProcessOptions(options.platform)
  /**
   * `["pipe", "pipe", "ignore"]` in `ensureChild` selects node's
   * `SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioNull>` overload, so
   * the spawn itself proves `stdin` is a `Writable` and `stdout` a `Readable`.
   * `ReturnType<typeof spawn>` resolves to the LAST overload rather than the
   * one selected, widening both back to nullable — which is what forced the
   * non-null assertions this type replaces. Keep the two in sync: change the
   * stdio tuple and this type changes with it.
   */
  let child: ChildProcessByStdio<Writable, Readable, null> | undefined
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
      return request("reconcile", { rootPids: boundedPids(rootPids) }, isReconcileReply)
    },
    sample(entries, at) {
      return request("sample", { entries: uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS), at }, isSampleReply)
    },
    probeCreation(pid) {
      return request("probeCreation", { pid }, isCreationIdentity)
    },
    clear() {
      // Fire-and-forget by design; `request` rejects on a bad reply and the
      // rejection is swallowed here because nothing waits on a cache clear.
      if (!disposed) void request("clear", {}, isNoReply).catch(() => undefined)
    },
    dispose() {
      if (disposed) return
      disposed = true
      child?.kill()
      failAll()
    },
  }

  /**
   * The single place a worker reply becomes a typed value.
   *
   * Each caller passes the reader for the shape it expects, so a reply that
   * does not match rejects the request instead of being asserted into the
   * caller's type and failing somewhere further away.
   */
  function request<T>(method: string, input: object, accept: (value: unknown) => value is T): Promise<T> {
    if (disposed || Date.now() < restartAfter) return Promise.reject(new Error("process metrics worker unavailable"))
    ensureChild()
    const stdin = child?.stdin
    if (!stdin?.writable) return Promise.reject(new Error("process metrics worker unavailable"))
    const id = ++sequence
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          if (accept(value)) resolve(value)
          else reject(new Error(`process metrics worker returned an invalid ${method} reply`))
        },
        reject,
        timer: setTimeout(() => timeout(id), options.requestTimeoutMs ?? DIAGNOSTICS_COLLECTOR_TIMEOUT_MS),
      })
      stdin.write(`${JSON.stringify({ id, method, ...input })}\n`)
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
    child = spawn(options.execPath ?? process.execPath, [options.workerPath ?? join(import.meta.dirname, "process-metrics-worker.js")], {
      cwd: policy.cwd,
      env: {
        ...policy.env,
        ELECTRON_RUN_AS_NODE: "1",
        CLAXEDO_DIAGNOSTICS_WORKER_PLATFORM: options.platform,
        ...(options.memoryHelperPath ? { CLAXEDO_DIAGNOSTICS_MEMORY_HELPER: options.memoryHelperPath } : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
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
          const envelope: unknown = JSON.parse(line)
          const id = readNumber(envelope, "id")
          if (id === undefined || !Number.isInteger(id)) return
          const request = pending.get(id)
          if (!request) return
          pending.delete(id)
          clearTimeout(request.timer)
          if (readUnknown(envelope, "ok") === true) {
            request.resolve(readUnknown(envelope, "value"))
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
  query(rows: number[], options?: { memoryImpact?: boolean }): Promise<unknown[]>
  logicalProcessors?: number
  monotonicNow?: () => number
  memoryImpactIntervalMs?: number
}): ProcessMetricsWorker {
  const logicalProcessors = options.logicalProcessors ?? Math.max(1, cpus().length)
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const history = new Map<number, { row: WindowsCimRow; at: number }>()
  const memoryImpact = new Map<number, number>()
  let nextMemoryImpactAt = Number.NEGATIVE_INFINITY
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
    async sample(entries, at) {
      if (disposed) return []
      const selected = uniqueEntries(entries).slice(0, MAX_DIAGNOSTICS_PIDS)
      const selectedPids = new Set(selected.map((entry) => entry.pid))
      history.forEach((_, pid) => {
        if (!selectedPids.has(pid)) history.delete(pid)
      })
      memoryImpact.forEach((_, pid) => {
        if (!selectedPids.has(pid)) memoryImpact.delete(pid)
      })
      const refreshMemoryImpact = at >= nextMemoryImpactAt
      const raw = await options.query(
        selected.map((entry) => entry.pid),
        { memoryImpact: refreshMemoryImpact },
      )
      if (refreshMemoryImpact) {
        memoryImpact.clear()
        nextMemoryImpactAt = at + (options.memoryImpactIntervalMs ?? 10_000)
      }
      const byPid = new Map(selected.map((entry) => [entry.pid, entry]))
      const sampledAt = monotonicNow()
      return raw.slice(0, MAX_DIAGNOSTICS_PIDS).flatMap((value) => {
        const row = parseWindowsCimRow(value)
        const entry = row ? byPid.get(row.pid) : undefined
        if (
          !row ||
          !entry ||
          row.rssBytes > BigInt(Number.MAX_SAFE_INTEGER) ||
          (row.memoryImpactBytes !== undefined && row.memoryImpactBytes > BigInt(Number.MAX_SAFE_INTEGER))
        ) return []
        const previous = history.get(row.pid)
        history.set(row.pid, { row, at: sampledAt })
        if (refreshMemoryImpact && row.memoryImpactBytes !== undefined) {
          memoryImpact.set(row.pid, Number(row.memoryImpactBytes))
        }
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
            memoryImpact: memoryImpact.get(row.pid) === undefined
              ? { kind: "rss-fallback" as const, bytes: Number(row.rssBytes) }
              : { kind: "private-working-set" as const, bytes: memoryImpact.get(row.pid)! },
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
      memoryImpact.clear()
      nextMemoryImpactAt = Number.NEGATIVE_INFINITY
    },
    dispose() {
      disposed = true
      history.clear()
      memoryImpact.clear()
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
    query(pids: number[], options?: { memoryImpact?: boolean }) {
      const selected = boundedPids(pids)
      if (selected.length === 0) return Promise.resolve([])
      if (Date.now() < restartAfter) return Promise.reject(new Error("Windows metrics source is recovering"))
      ensureChild()
      const stdin = child?.stdin
      if (!stdin?.writable) return Promise.reject(new Error("Windows metrics source unavailable"))
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
        stdin.write(`${JSON.stringify({ pids: selected, memoryImpact: options?.memoryImpact === true })}\n`)
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
        const envelope: unknown = JSON.parse(line)
        const rows = readArray(envelope, "rows")
        if (readUnknown(envelope, "ok") !== true || !rows || rows.length > MAX_DIAGNOSTICS_PIDS) {
          // The worker's own reason when it sent one, so a CIM failure is
          // distinguishable from a malformed envelope. Everything past the
          // colon comes from the worker's capped message field.
          const reason = readString(envelope, "reason")
          request.reject(
            new Error(
              reason ? `Windows metrics response rejected: ${reason.slice(0, 200)}` : "Windows metrics response rejected",
            ),
          )
          return
        }
        request.resolve(rows)
      } catch {
        request.reject(new Error("Windows metrics response rejected: unparsable response"))
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
