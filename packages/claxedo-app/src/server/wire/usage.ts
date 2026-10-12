import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"
import type { MachineTimeProvider as MachineTimeProviderWire, MachineTimeRate, MachineTimeResponse, MachineTimeWorkspace as MachineTimeWorkspaceWire } from "@claxedo/usage-contract"
import { contractMismatch } from "../errors"
import { placementId, projectId } from "../ids"
import type { MachineRate, MachineTime, MachineTimeProvider, MachineTimeWorkspace, UsageSummary } from "../usage-types"

const MACHINE_TIME_FIELDS = ["since", "until", "activeMs", "running"] as const satisfies readonly (keyof MachineTimeResponse)[]

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isMachineTime(value: unknown): value is MachineTimeResponse {
  return isRecord(value) && MACHINE_TIME_FIELDS.every((field) => finite(value[field])) && Array.isArray(value.workspaces) && Array.isArray(value.providers)
}

function isRate(value: unknown): value is MachineTimeRate {
  return isRecord(value) && nonEmptyString(value.size) !== undefined && finite(value.vcpu) && finite(value.memoryGb) && finite(value.usdPerHour)
}

function rateFromWire(rate: MachineTimeRate): MachineRate {
  return { size: rate.size, vcpu: rate.vcpu, memoryGb: rate.memoryGb, usdPerHour: rate.usdPerHour }
}

function isWorkspace(value: unknown): value is MachineTimeWorkspaceWire {
  return isRecord(value) && nonEmptyString(value.workspaceId) !== undefined && nonEmptyString(value.provider) !== undefined
    && nonEmptyString(value.providerLabel) !== undefined && finite(value.activeMs)
    && (value.rate === undefined) === (value.costUsd === undefined) && (value.rate === undefined || (isRate(value.rate) && finite(value.costUsd)))
}

function workspaceFromWire(row: MachineTimeWorkspaceWire): MachineTimeWorkspace {
  const project = nonEmptyString(row.projectId)
  const name = nonEmptyString(row.name)
  const branch = nonEmptyString(row.branch)
  const machineClass = nonEmptyString(row.machineClass)
  return {
    id: placementId(row.workspaceId),
    ...(project ? { projectId: projectId(project) } : {}),
    ...(name && name !== row.workspaceId ? { name } : {}),
    ...(branch ? { branch } : {}),
    provider: row.provider,
    providerLabel: row.providerLabel,
    ...(machineClass ? { machineClass } : {}),
    activeMs: row.activeMs,
    ...(finite(row.runningSince) ? { runningSince: row.runningSince } : {}),
    ...(row.rate && row.costUsd !== undefined ? { rate: rateFromWire(row.rate), costUsd: row.costUsd } : {}),
  }
}

function isProvider(value: unknown): value is MachineTimeProviderWire {
  return isRecord(value) && nonEmptyString(value.provider) !== undefined && nonEmptyString(value.label) !== undefined
    && nonEmptyString(value.meter) !== undefined && isRecord(value.source) && nonEmptyString(value.source.url) !== undefined && nonEmptyString(value.source.readOn) !== undefined
}

function providerFromWire(provider: MachineTimeProviderWire): MachineTimeProvider {
  const excludes = nonEmptyString(provider.excludes)
  return { provider: provider.provider, label: provider.label, meter: provider.meter, source: { url: provider.source.url, readOn: provider.source.readOn }, ...(excludes ? { excludes } : {}) }
}

export function machineTimeFromWire(body: unknown): MachineTime {
  if (!isMachineTime(body) || !body.workspaces.every(isWorkspace) || !body.providers.every(isProvider)) throw contractMismatch("machine time")
  return {
    since: body.since,
    until: body.until,
    activeMs: body.activeMs,
    running: body.running,
    workspaces: body.workspaces.map(workspaceFromWire),
    providers: body.providers.map(providerFromWire),
  }
}

function isUsageSummary(value: unknown): value is UsageSummary {
  return isRecord(value) && value.version === 1 && isRecord(value.range) && isRecord(value.quota) && isRecord(value.claxedo) && isRecord(value.filterOptions)
}

export function usageSummaryFromWire(body: unknown): UsageSummary {
  if (!isUsageSummary(body)) throw contractMismatch("usage")
  return body
}
