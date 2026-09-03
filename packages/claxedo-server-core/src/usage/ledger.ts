import type { TurnUsageRevision } from "./contracts"

export type TurnStatus = "ok" | "error"

export type LlmTurnRecord = {
  message_id: string
  session_id: string
  stream_id?: string
  run_id?: string
  work_item_id?: string
  harness: string
  provider_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  turn_status: TurnStatus
  latency_ms: number
  settlement?: "provisional" | "final" | "partial" | "unavailable" | "recovered"
  known_token_categories?: string[]
}

export type UsageRevisionResult = {
  status: "accepted" | "duplicate" | "stale" | "conflict"
  currentRevision?: number
  activated: boolean
}

/** One authority contract shared by metering, sync, and dashboard reads. */
export type UsageLedger = {
  resolveHostedAttribution?: (input: {
    org_id: string
    user_id: string
    session_id: string
  }) => Promise<Readonly<{ stream_id?: string; run_id?: string; work_item_id?: string }> | undefined>
  recordLlmTurn: (input: LlmTurnRecord & { org_id: string; user_id: string }) => Promise<{ activated: boolean }>
  recordTurnUsageRevision?: (
    input: TurnUsageRevision & { org_id: string; user_id: string },
  ) => Promise<UsageRevisionResult>
  recordTurnUsageBatch?: (input: {
    org_id: string
    user_id: string
    revisions: TurnUsageRevision[]
  }) => Promise<UsageRevisionResult[]>
  usageDashboard?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
    timeZone?: string
    dimension?: "provider" | "harness" | "model" | "location" | "session" | "workspace"
    filters?: Partial<Record<"provider" | "harness" | "model" | "location" | "session" | "workspace", string>>
  }) => Promise<unknown>
  usageBreakdown?: (input: {
    org_id: string
    user_id: string
    since: number
    until: number
    dimension: "provider" | "harness" | "model" | "location" | "session" | "workspace"
    after?: string
    limit?: number
  }) => Promise<unknown>
}
