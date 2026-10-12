import type { UnifiedUsageResponse, UsageFilters } from "@claxedo/usage-contract"
import type { PlacementId, ProjectId } from "./ids"

export type UsageRequest = {
  readonly since: number
  readonly until: number
  readonly timeZone: string
  readonly view?: "quota" | "claxedo"
  readonly group?: "provider" | "harness" | "model" | "location" | "session" | "workspace" | "app"
  readonly metric?: "tokens" | "cost"
  readonly filters?: UsageFilters
  readonly after?: string
  readonly modelAfter?: string
  readonly limit?: number
  readonly refreshNonce?: number
}

export type UsageSummary = UnifiedUsageResponse

export type MachineRate = {
  readonly size: string
  readonly vcpu: number
  readonly memoryGb: number
  readonly usdPerHour: number
}

export type MachineTimeWorkspace = {
  readonly id: PlacementId
  readonly projectId?: ProjectId
  readonly name?: string
  readonly branch?: string
  readonly provider: string
  readonly providerLabel: string
  readonly machineClass?: string
  readonly activeMs: number
  readonly runningSince?: number
  readonly rate?: MachineRate
  readonly costUsd?: number
}

export type MachineTimeProvider = {
  readonly provider: string
  readonly label: string
  readonly meter: string
  readonly source: { readonly url: string; readonly readOn: string }
  readonly excludes?: string
}

export type MachineTime = {
  readonly since: number
  readonly until: number
  readonly activeMs: number
  readonly running: number
  readonly workspaces: readonly MachineTimeWorkspace[]
  readonly providers: readonly MachineTimeProvider[]
}
