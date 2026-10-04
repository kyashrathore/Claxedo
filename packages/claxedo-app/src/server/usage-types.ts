import type { UnifiedUsageResponse, UsageFilters } from "@claxedo/usage-contract"

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
