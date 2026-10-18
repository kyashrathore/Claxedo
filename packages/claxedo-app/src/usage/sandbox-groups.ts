import type { MachineTime, ProjectId } from "@/server"
import type { CostEstimate } from "./cost-estimate"
import { estimate, isRunningRow, type SandboxRow } from "./sandbox-rows"

export type SandboxFilter = "all" | "running"

export type SandboxProjectGroup = {
  readonly projectId?: ProjectId
  readonly rows: readonly SandboxRow[]
  readonly activeMs: number
  readonly cost: CostEstimate
  readonly running: boolean
}

export type SandboxProviderTotal = {
  readonly provider: string
  readonly label: string
  readonly activeMs: number
  readonly cost: CostEstimate
}

export type SandboxGroupList =
  | { readonly kind: "groups"; readonly groups: readonly SandboxProjectGroup[] }
  | { readonly kind: "empty" }
  | { readonly kind: "unknown" }

function groupOf(rows: readonly SandboxRow[]): SandboxProjectGroup {
  const machines = rows.flatMap((row) => row.machines)
  const projectId = rows[0]?.projectId
  return {
    ...(projectId ? { projectId } : {}),
    rows,
    activeMs: machines.reduce((total, machine) => total + machine.activeMs, 0),
    cost: estimate(machines.map((machine) => machine.costUsd)),
    running: rows.some(isRunningRow),
  }
}

export function sandboxProjectGroups(rows: readonly SandboxRow[]): readonly SandboxProjectGroup[] {
  const byProject = new Map<ProjectId | undefined, SandboxRow[]>()
  for (const row of rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row])
  return [...byProject.values()].map(groupOf)
}

export function listSandboxGroups(rows: readonly SandboxRow[], filter: SandboxFilter, read: { readonly time: boolean; readonly live: boolean }): SandboxGroupList {
  const shown = filter === "running" ? rows.filter(isRunningRow) : rows
  if (shown.length > 0) return { kind: "groups", groups: sandboxProjectGroups(shown) }
  return read.time && read.live ? { kind: "empty" } : { kind: "unknown" }
}

export function sandboxProviderTotals(time: MachineTime): readonly SandboxProviderTotal[] {
  const byProvider = new Map<string, MachineTime["workspaces"][number][]>()
  for (const machine of time.workspaces) byProvider.set(machine.provider, [...(byProvider.get(machine.provider) ?? []), machine])
  return [...byProvider].map(([provider, machines]) => ({
    provider,
    label: machines[0]?.providerLabel ?? provider,
    activeMs: machines.reduce((total, machine) => total + machine.activeMs, 0),
    cost: estimate(machines.map((machine) => machine.costUsd)),
  })).sort((a, b) => b.activeMs - a.activeMs)
}
