import type { UnifiedUsageResponse, UsageFilters, UsageTotals } from "@claxedo/usage-contract"
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
  readonly lastStoppedAt?: number
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

export type AccountSpendScope = "mine" | "org"

export type AccountSpendRequest = {
  readonly since: number
  readonly until: number
  readonly scope: AccountSpendScope
}

export type SpentAccount = {
  readonly accountId: string
  readonly access: "plan" | "apiKey"
  readonly label?: string
  readonly providerId?: string
}

export type AccountSpendPayer =
  | ({ readonly kind: "own" } & SpentAccount)
  | ({ readonly kind: "team" } & SpentAccount)
  | { readonly kind: "otherMember" }
  | { readonly kind: "machine" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "unreported" }

export type AccountSpend = {
  readonly payer: AccountSpendPayer
  readonly totals: UsageTotals
  readonly cost: { readonly estimatedUsd: number; readonly pricedTokens: number; readonly unpricedTokens: number }
}

export type AccountSpendReport = {
  readonly since: number
  readonly until: number
  readonly scope: AccountSpendScope
  readonly accounts: readonly AccountSpend[]
}
