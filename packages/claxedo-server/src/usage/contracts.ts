import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"

export type TurnUsageSettlement = "provisional" | "final" | "partial" | "unavailable" | "recovered"

export type TurnUsageStatus =
  | "running"
  | "completed"
  | "error"
  | "stopped"
  | "interrupted_by_steer"
  | "process_lost"

export type TurnUsageLocation = "local" | "central" | "cloud-workspace" | "user-hosted"

export type TurnUsageQuality = {
  source: "provider" | "provider-message" | "lifecycle"
  observationKind?: "cumulative" | "delta"
  providerObservationId?: string
  knownCategories: Array<"input" | "output" | "reasoning" | "cache_read" | "cache_write">
}

/**
 * The minimal, privacy-bounded fact shared by local persistence and central
 * ingest. Prompts, responses, paths, credentials, and provider auth material
 * have no representation in this contract.
 */
export type TurnUsageRevision = {
  sessionRef: string
  sessionId: string
  messageId: string
  revision: number
  observedAt: number
  completedAt?: number
  settlement: TurnUsageSettlement
  status: TurnUsageStatus
  location: TurnUsageLocation
  harness: string
  providerId: string
  modelId: string
  /** Local provider-native identity used to exclude Claxedo sessions before history aggregation. */
  nativeSessionId?: string
  workspaceId?: string
  hostId: string
  tokens: RuntimeTokenUsage
  quality: TurnUsageQuality
}

export type UsageRevisionWriteResult =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "stale"; currentRevision: number }
  | { status: "conflict"; currentRevision: number }

export type UsageRevisionWriter = {
  writeRevision(fact: TurnUsageRevision): Promise<UsageRevisionWriteResult>
}

export type UsageRevisionReader = {
  current(input?: { hostId?: string; since?: number; until?: number }): Promise<TurnUsageRevision[]>
  pendingOutbox(input?: { limit?: number; all?: boolean; since?: number; until?: number }): Promise<TurnUsageRevision[]>
}

export function knownTokenCategories(tokens: RuntimeTokenUsage): TurnUsageQuality["knownCategories"] {
  const out: TurnUsageQuality["knownCategories"] = []
  if (tokens.input !== null) out.push("input")
  if (tokens.output !== null) out.push("output")
  if (tokens.reasoning !== null) out.push("reasoning")
  if (tokens.cache.read !== null) out.push("cache_read")
  if (tokens.cache.write !== null) out.push("cache_write")
  return out
}

export function assertTurnUsageRevision(fact: TurnUsageRevision) {
  const required = [fact.sessionRef, fact.sessionId, fact.messageId, fact.hostId, fact.harness, fact.providerId, fact.modelId]
  if (required.some((value) => !value.trim())) throw new Error("usage revision identifiers must be non-empty")
  if (!Number.isSafeInteger(fact.revision) || fact.revision < 1) throw new Error("usage revision must be a positive integer")
  if (!Number.isFinite(fact.observedAt) || fact.observedAt < 0) throw new Error("usage observedAt must be non-negative")
  for (const value of [fact.tokens.input, fact.tokens.output, fact.tokens.reasoning, fact.tokens.cache.read, fact.tokens.cache.write]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("usage token values must be non-negative integers or null")
    }
  }
}
