import type { TurnUsageRevision } from "./contracts"

/** The store the hosted plane files its cloud workspaces' turns in, as its usage routes read it. */
export type UsageProjectionLedger = {
  usageDashboard?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
    timeZone?: string
    dimension?: "provider" | "harness" | "model" | "location" | "session" | "workspace"
    filters?: Partial<Record<"provider" | "harness" | "model" | "location" | "session" | "workspace", string>>
  }) => Promise<unknown>
  /**
   * The latest revision of every turn this account ran in a cloud workspace
   * and observed in [since, until], oldest first, at most `limit` of them.
   */
  cloudUsageFacts?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
    limit: number
  }) => Promise<TurnUsageRevision[]>
}
