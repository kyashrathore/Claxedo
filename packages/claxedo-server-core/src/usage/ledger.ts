import type { MachineTimeResponse } from "@claxedo/usage-contract"
import type { TurnUsageCredentialSource, TurnUsageRevision } from "./contracts"
import type { CentralUsageRow } from "./projection"

/**
 * Whose credential spend a read covers. `mine`: every turn that spent one of
 * the reader's own accounts, whoever sent it, and the reader's own turns on
 * anything else. `org`: every member's turns on the organization's team keys,
 * for an administrator of the organization alone.
 */
export type CredentialSpendScope = "mine" | "org"

/**
 * One credential's usage on one model. `other_member` is another person's own
 * account that the reader's turns spent on a session shared with them, named
 * by nothing of that account's.
 */
export type CredentialSpendRow = CentralUsageRow & {
  source: TurnUsageCredentialSource | "other_member"
  credential_id: string | null
  credential_kind: string | null
  label: string | null
  credential_provider_id: string | null
  /** The member whose turns these are, for `org` scope alone. */
  spender: string | null
  model: string
}

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
  /** Nothing when the reader may not read `scope`. */
  credentialSpend?: (input: {
    org_id: string
    user_id: string
    scope: CredentialSpendScope
    since: number
    until: number
  }) => Promise<CredentialSpendRow[] | undefined>
  /** The machine time of this account's own cloud workspaces in [since, until], per workspace and priced where the provider's rate is known. */
  machineTime?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
  }) => Promise<Omit<MachineTimeResponse, "since" | "until">>
}
