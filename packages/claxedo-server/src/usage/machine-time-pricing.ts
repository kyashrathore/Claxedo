import { sandboxDriverCatalog, sandboxMachineCostUsd, sandboxMachineRate } from "@claxedo/sandbox-manager/driver-catalog"
import { isSandboxDriverID, isSandboxMachineClass } from "@claxedo/sandbox-contract"
import type { UsageProjectionLedger } from "@claxedo/server-core/usage/ledger"
import type { MachineTimeRow } from "../sandbox/stores/d1-boots"

export type PricedMachineTime = Awaited<ReturnType<NonNullable<UsageProjectionLedger["machineTime"]>>>
type MachineTimeWorkspace = PricedMachineTime["workspaces"][number]
type MachineTimeProvider = PricedMachineTime["providers"][number]

/**
 * The machine-time rows as the usage route answers them: priced at the catalog's published rate for the driver and
 * size where one is established, running ones first, then the longest. A row on a driver outside the catalog, or a
 * size the catalog has no rate for, keeps its minutes and carries no cost.
 */
export function priceMachineTime(rows: readonly MachineTimeRow[]): PricedMachineTime {
  const workspaces = rows.map(pricedWorkspace).sort(runningFirstThenLongest)
  return {
    activeMs: rows.reduce((total, row) => total + row.active_ms, 0),
    running: rows.filter((row) => row.running_since !== null).length,
    workspaces,
    providers: providersAmong(rows),
  }
}

function pricedWorkspace(row: MachineTimeRow): MachineTimeWorkspace {
  const driver = isSandboxDriverID(row.driver) ? sandboxDriverCatalog[row.driver] : undefined
  const machineClass = isSandboxMachineClass(row.machine_class) ? row.machine_class : null
  const rate = sandboxMachineRate(driver?.billing, machineClass)
  return {
    workspaceId: row.workspace_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.display_name ? { name: row.display_name } : {}),
    ...(row.git_branch ? { branch: row.git_branch } : {}),
    provider: row.driver,
    providerLabel: driver?.label ?? row.driver,
    machineClass: row.machine_class,
    activeMs: row.active_ms,
    ...(row.running_since === null ? {} : { runningSince: row.running_since }),
    ...(rate ? { rate, costUsd: sandboxMachineCostUsd(rate, row.active_ms) } : {}),
  }
}

function runningFirstThenLongest(a: MachineTimeWorkspace, b: MachineTimeWorkspace): number {
  return Number(b.runningSince !== undefined) - Number(a.runningSince !== undefined) || b.activeMs - a.activeMs || a.workspaceId.localeCompare(b.workspaceId)
}

function providersAmong(rows: readonly MachineTimeRow[]): MachineTimeProvider[] {
  return [...new Set(rows.map((row) => row.driver))].sort().flatMap((id) => {
    const driver = isSandboxDriverID(id) ? sandboxDriverCatalog[id] : undefined
    if (!driver?.billing) return []
    const { meter, source, excludes } = driver.billing
    return [{ provider: id, label: driver.label, meter, source, ...(excludes ? { excludes } : {}) }]
  })
}
