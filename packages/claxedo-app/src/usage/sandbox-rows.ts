import type { CloudWorkspaceRow } from "@/cloud"
import type { MachineTime, MachineTimeWorkspace, PlacementId, ProjectId } from "@/server"
import type { CostEstimate } from "./cost-estimate"

export type SandboxRow = {
  readonly id: PlacementId
  readonly projectId?: ProjectId
  readonly name?: string
  readonly branch?: string
  readonly activeMs: number
  readonly cost: CostEstimate
  readonly runningSince?: number
  readonly lastStoppedAt?: number
  readonly machines: readonly MachineTimeWorkspace[]
  readonly live?: CloudWorkspaceRow
}

export type SandboxFilter = "all" | "running"

export type SandboxTotals = {
  readonly activeMs: number
  readonly cost: CostEstimate
  readonly running: number
  readonly hourly: CostEstimate
}

function estimate(amounts: readonly (number | undefined)[]): CostEstimate {
  const priced = amounts.filter((amount): amount is number => amount !== undefined)
  const usd = priced.reduce((total, amount) => total + amount, 0)
  if (amounts.length === 0) return { kind: "none" }
  if (priced.length === 0) return { kind: "unknown" }
  return priced.length === amounts.length ? { kind: "complete", usd } : { kind: "partial", usd }
}

function latest(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined)
  return known.length > 0 ? Math.max(...known) : undefined
}

function rowOf(id: PlacementId, machines: readonly MachineTimeWorkspace[], live: CloudWorkspaceRow | undefined, liveLoaded: boolean): SandboxRow {
  const first = machines[0]
  const projectId = first?.projectId ?? live?.projectId
  const name = first?.name ?? live?.name
  const branch = first?.branch ?? live?.branch
  const runningSince = liveLoaded && !live ? undefined : latest(machines.map((machine) => machine.runningSince))
  const lastStoppedAt = latest(machines.map((machine) => machine.lastStoppedAt))
  return {
    id,
    ...(projectId ? { projectId } : {}),
    ...(name ? { name } : {}),
    ...(branch ? { branch } : {}),
    activeMs: machines.reduce((total, machine) => total + machine.activeMs, 0),
    cost: estimate(machines.map((machine) => machine.costUsd)),
    ...(runningSince !== undefined ? { runningSince } : {}),
    ...(lastStoppedAt !== undefined ? { lastStoppedAt } : {}),
    machines,
    ...(live ? { live } : {}),
  }
}

export function isRunningRow(row: SandboxRow): boolean {
  return row.live !== undefined || row.runningSince !== undefined
}

function byRunningThenRecent(a: SandboxRow, b: SandboxRow): number {
  return Number(isRunningRow(b)) - Number(isRunningRow(a))
    || (b.lastStoppedAt ?? 0) - (a.lastStoppedAt ?? 0)
    || b.activeMs - a.activeMs
}

export function sandboxRows(time: MachineTime | undefined, live: readonly CloudWorkspaceRow[] | undefined): readonly SandboxRow[] {
  const machinesById = new Map<PlacementId, MachineTimeWorkspace[]>()
  for (const machine of time?.workspaces ?? []) machinesById.set(machine.id, [...(machinesById.get(machine.id) ?? []), machine])
  const liveLoaded = live !== undefined
  const liveById = new Map((live ?? []).map((row) => [row.id, row]))
  const timed = [...machinesById].map(([id, machines]) => rowOf(id, machines, liveById.get(id), liveLoaded))
  const starting = (live ?? []).filter((row) => !machinesById.has(row.id)).map((row) => rowOf(row.id, [], row, liveLoaded))
  return [...timed, ...starting].sort(byRunningThenRecent)
}

export type SandboxRowList =
  | { readonly kind: "rows"; readonly rows: readonly SandboxRow[] }
  | { readonly kind: "empty" }
  | { readonly kind: "unknown" }

export function listSandboxRows(rows: readonly SandboxRow[], filter: SandboxFilter, read: { readonly time: boolean; readonly live: boolean }): SandboxRowList {
  const shown = filter === "running" ? rows.filter(isRunningRow) : rows
  if (shown.length > 0) return { kind: "rows", rows: shown }
  return read.time && read.live ? { kind: "empty" } : { kind: "unknown" }
}

export function sandboxTotals(rows: readonly SandboxRow[]): SandboxTotals {
  const machines = rows.flatMap((row) => row.machines)
  const running = rows.filter(isRunningRow)
  const servingNow = running.flatMap((row) => row.machines.filter((machine) => machine.runningSince !== undefined))
  return {
    activeMs: machines.reduce((total, machine) => total + machine.activeMs, 0),
    cost: estimate(machines.map((machine) => machine.costUsd)),
    running: running.length,
    hourly: estimate(servingNow.map((machine) => machine.rate?.usdPerHour)),
  }
}
