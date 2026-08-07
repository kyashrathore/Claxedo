import type { LocalDiagnostics } from "@claxedo/app/process-diagnostics-contract"

export type WindowsCimRow = {
  pid: number
  ppid: number
  creationTicks: bigint
  kernelTicks: bigint
  userTicks: bigint
  rssBytes: bigint
  memoryImpactBytes?: bigint
}

export function parseLinuxStartTicks(stat: string) {
  const end = stat.lastIndexOf(") ")
  if (end < 0) return
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  const value = fields[19]
  if (!value || !/^\d+$/.test(value)) return
  return value
}

export function linuxCreationIdentity(stat: string): LocalDiagnostics.CreationIdentity {
  const value = parseLinuxStartTicks(stat)
  if (!value) return { state: "unavailable", reason: "identity-unavailable" }
  return { state: "available", value, source: "linux-proc" }
}

export function parseWindowsCimRow(input: unknown): WindowsCimRow | undefined {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  if (!validPid(row.pid) || !validParentPid(row.ppid)) return
  const creationTicks = decimal(row.creationTicks)
  const kernelTicks = decimal(row.kernelTicks)
  const userTicks = decimal(row.userTicks)
  const rssBytes = decimal(row.rssBytes)
  const memoryImpactBytes = row.memoryImpactBytes === undefined ? undefined : decimal(row.memoryImpactBytes)
  if (creationTicks === undefined || kernelTicks === undefined || userTicks === undefined || rssBytes === undefined)
    return
  if (row.memoryImpactBytes !== undefined && memoryImpactBytes === undefined) return
  return { pid: row.pid, ppid: row.ppid, creationTicks, kernelTicks, userTicks, rssBytes, ...(memoryImpactBytes === undefined ? {} : { memoryImpactBytes }) }
}

export function windowsCreationIdentity(row: WindowsCimRow): LocalDiagnostics.CreationIdentity {
  return { state: "available", value: row.creationTicks.toString(), source: "windows-cim" }
}

export function windowsCpuMachinePercent(input: {
  previous: WindowsCimRow | undefined
  current: WindowsCimRow
  elapsedMs: number
  logicalProcessors: number
}): LocalDiagnostics.CpuMachinePercent {
  if (!input.previous || input.previous.creationTicks !== input.current.creationTicks) {
    return { state: "unavailable", reason: "warming-up" }
  }
  const previousTicks = input.previous.kernelTicks + input.previous.userTicks
  const currentTicks = input.current.kernelTicks + input.current.userTicks
  if (
    currentTicks < previousTicks ||
    !Number.isFinite(input.elapsedMs) ||
    input.elapsedMs <= 0 ||
    !Number.isInteger(input.logicalProcessors) ||
    input.logicalProcessors <= 0
  ) {
    return { state: "unavailable", reason: "not-sampled" }
  }
  const processMs = Number(currentTicks - previousTicks) / 10_000
  if (!Number.isFinite(processMs)) return { state: "unavailable", reason: "not-sampled" }
  return {
    state: "available",
    value: Math.min(100, Math.max(0, (processMs / input.elapsedMs / input.logicalProcessors) * 100)),
  }
}

export function processIdentity(input: {
  domain: LocalDiagnostics.Domain
  pid: number
  creation: LocalDiagnostics.CreationIdentity
  launchId?: string
}): LocalDiagnostics.ProcessIdentity {
  const creation = input.creation.state === "available" ? input.creation.value : (input.launchId ?? "unknown")
  return {
    id: `${input.domain}:${String(input.pid)}:${creation}`,
    domain: input.domain,
    pid: input.pid,
    creation: input.creation,
    ...(input.launchId ? { launchId: input.launchId } : {}),
  }
}

export function sameCreationIdentity(
  expected: LocalDiagnostics.CreationIdentity,
  actual: LocalDiagnostics.CreationIdentity,
) {
  return (
    expected.state === "available" &&
    actual.state === "available" &&
    expected.source === actual.source &&
    expected.value === actual.value
  )
}

export async function probeProcessCreationIdentity(options: {
  platform: NodeJS.Platform
  pid: number
  electronMetrics?: () => Array<{ pid: number; creationTime: number }>
  readLinuxStat?: (pid: number) => Promise<string>
  queryWindows?: (pids: number[]) => Promise<unknown[]>
}): Promise<LocalDiagnostics.CreationIdentity> {
  const electron = options.electronMetrics?.().find((metric) => metric.pid === options.pid)
  if (electron && Number.isFinite(electron.creationTime) && electron.creationTime >= 0) {
    return { state: "available", value: String(Math.trunc(electron.creationTime)), source: "electron" }
  }
  if (options.platform === "linux" && options.readLinuxStat) {
    try {
      return linuxCreationIdentity(await options.readLinuxStat(options.pid))
    } catch {
      return { state: "unavailable", reason: "identity-unavailable" }
    }
  }
  if (options.platform === "win32" && options.queryWindows) {
    try {
      const row = (await options.queryWindows([options.pid]))
        .map(parseWindowsCimRow)
        .find((value) => value?.pid === options.pid)
      return row ? windowsCreationIdentity(row) : { state: "unavailable", reason: "identity-unavailable" }
    } catch {
      return { state: "unavailable", reason: "identity-unavailable" }
    }
  }
  return { state: "unavailable", reason: "identity-unavailable" }
}

function decimal(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || value.length > 32) return
  return BigInt(value)
}

export function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0x7fffffff
}

function validParentPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
}
