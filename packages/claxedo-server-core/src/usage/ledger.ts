import type { MachineTimeResponse } from "@claxedo/usage-contract"
import type { TurnUsageRevision } from "./contracts"

/** The store the hosted plane files its cloud workspaces' turns and boots in, as its usage routes read it. */
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
  /** The model of this account's newest turn on `harness` observed at or after `since` that completed; nothing when there is none. */
  latestHarnessModel?: (input: {
    org_id: string
    user_id: string
    harness: string
    since: number
  }) => Promise<string | undefined>
  /** The machine time of this account's own cloud workspaces in [since, until], per workspace and priced where the provider's rate is known. */
  machineTime?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
  }) => Promise<Omit<MachineTimeResponse, "since" | "until">>
}
