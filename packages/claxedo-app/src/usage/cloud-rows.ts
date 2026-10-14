import type { CloudWorkspaceRow } from "@/cloud"
import type { MachineTime, MachineTimeWorkspace, PlacementId, ProjectId } from "@/server"

export type CloudRow = {
  readonly key: string
  readonly id: PlacementId
  readonly projectId?: ProjectId
  readonly name?: string
  readonly branch?: string
  readonly time?: MachineTimeWorkspace
  readonly live?: CloudWorkspaceRow
  readonly running: boolean
}

export type CloudCost = {
  readonly usd: number
  readonly pricedMs: number
  readonly unpricedMs: number
  readonly unpricedProviders: readonly string[]
}

function machineTimeRowKey(time: MachineTimeWorkspace): string {
  return `${time.id} ${time.provider} ${time.machineClass ?? ""}`
}

export function cloudRows(time: MachineTime | undefined, live: readonly CloudWorkspaceRow[] | undefined): readonly CloudRow[] {
  const liveById = new Map((live ?? []).map((row) => [row.id, row]))
  const timed = (time?.workspaces ?? []).map((workspace): CloudRow => {
    const current = liveById.get(workspace.id)
    return {
      key: machineTimeRowKey(workspace),
      id: workspace.id,
      ...(workspace.projectId ?? current?.projectId ? { projectId: workspace.projectId ?? current?.projectId } : {}),
      ...(workspace.name ?? current?.name ? { name: workspace.name ?? current?.name } : {}),
      ...(workspace.branch ?? current?.branch ? { branch: workspace.branch ?? current?.branch } : {}),
      time: workspace,
      ...(current ? { live: current } : {}),
      running: live ? current !== undefined : workspace.runningSince !== undefined,
    }
  })
  const timedIds = new Set(timed.map((row) => row.id))
  const starting = (live ?? []).filter((row) => !timedIds.has(row.id)).map((row): CloudRow => ({
    key: row.id,
    id: row.id,
    projectId: row.projectId,
    ...(row.name ? { name: row.name } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    live: row,
    running: true,
  }))
  return [...timed, ...starting]
}

export function cloudCost(workspaces: readonly MachineTimeWorkspace[]): CloudCost {
  const priced = workspaces.filter((workspace) => workspace.costUsd !== undefined)
  const unpriced = workspaces.filter((workspace) => workspace.costUsd === undefined)
  return {
    usd: priced.reduce((total, workspace) => total + (workspace.costUsd ?? 0), 0),
    pricedMs: priced.reduce((total, workspace) => total + workspace.activeMs, 0),
    unpricedMs: unpriced.reduce((total, workspace) => total + workspace.activeMs, 0),
    unpricedProviders: [...new Set(unpriced.map((workspace) => workspace.providerLabel))],
  }
}
