import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import { isJsonRecord, isOneOf } from "../platform/runtime/lib/json"

// The runtime lists are the single source for these unions: the SQLite schema
// declares its columns from them, and boundary parsers narrow against them.
export const TURN_USAGE_SETTLEMENTS = ["provisional", "final", "partial", "unavailable", "recovered"] as const
export const TURN_USAGE_STATUSES = [
  "running",
  "completed",
  "error",
  "stopped",
  "interrupted_by_steer",
  "process_lost",
] as const
export const TURN_USAGE_LOCATIONS = ["local", "cloud-workspace"] as const

export type TurnUsageSettlement = (typeof TURN_USAGE_SETTLEMENTS)[number]

export type TurnUsageStatus = (typeof TURN_USAGE_STATUSES)[number]

export type TurnUsageLocation = (typeof TURN_USAGE_LOCATIONS)[number]

export const TURN_USAGE_QUALITY_SOURCES = ["provider", "provider-message", "lifecycle"] as const
export const TURN_USAGE_OBSERVATION_KINDS = ["cumulative", "delta"] as const
export const TURN_USAGE_TOKEN_CATEGORIES = ["input", "output", "reasoning", "cache_read", "cache_write"] as const

export type TurnUsageQuality = {
  source: (typeof TURN_USAGE_QUALITY_SOURCES)[number]
  observationKind?: (typeof TURN_USAGE_OBSERVATION_KINDS)[number]
  providerObservationId?: string
  /** Stable local replay identity for the exact provider observation. */
  providerObservationKey?: string
  knownCategories: Array<(typeof TURN_USAGE_TOKEN_CATEGORIES)[number]>
}

/**
 * Read a persisted `quality` blob.
 *
 * A blob this package wrote round-trips exactly. Anything else — a hand-edited
 * row, a blob from a future schema — degrades to the fields it can prove rather
 * than failing the whole read, because provenance detail is not worth losing a
 * usage revision over.
 */
export function readTurnUsageQuality(value: unknown): TurnUsageQuality {
  if (!isJsonRecord(value)) return { source: "provider", knownCategories: [] }
  const declared = value.knownCategories
  const knownCategories = Array.isArray(declared)
    ? TURN_USAGE_TOKEN_CATEGORIES.filter((category) => declared.includes(category))
    : []
  return {
    source: isOneOf(value.source, TURN_USAGE_QUALITY_SOURCES) ? value.source : "provider",
    ...(isOneOf(value.observationKind, TURN_USAGE_OBSERVATION_KINDS)
      ? { observationKind: value.observationKind }
      : {}),
    ...(typeof value.providerObservationId === "string"
      ? { providerObservationId: value.providerObservationId }
      : {}),
    ...(typeof value.providerObservationKey === "string"
      ? { providerObservationKey: value.providerObservationKey }
      : {}),
    knownCategories: [...knownCategories],
  }
}

/** The minimal privacy-bounded fact shared by local persistence and central ingest. */
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

/**
 * The account a fact is attributed to when it uploads. Ownership is outbox
 * routing, not fact content: it is resolved by the composition from the
 * session's producing identity, never from the request that later asks to
 * sync, and it stays out of `TurnUsageRevision` so reattribution can never
 * collide with the revision's payload hash.
 */
export type UsageOwner = { org_id: string; user_id: string }

export type UsageRevisionWriter = {
  writeRevision(fact: TurnUsageRevision, options?: { owner?: UsageOwner }): Promise<UsageRevisionWriteResult>
}

export type UsageRevisionReader = {
  current(input?: {
    hostId?: string
    sessionRef?: string
    sessionId?: string
    messageId?: string
    since?: number
    until?: number
    settlement?: TurnUsageSettlement
  }): Promise<TurnUsageRevision[]>
  pendingOutbox(input?: {
    limit?: number
    all?: boolean
    since?: number
    until?: number
    owner?: UsageOwner
  }): Promise<TurnUsageRevision[]>
}

export function knownTokenCategories(tokens: TurnUsageRevision["tokens"]): TurnUsageQuality["knownCategories"] {
  const out: TurnUsageQuality["knownCategories"] = []
  if (tokens.input !== null) out.push("input")
  if (tokens.output !== null) out.push("output")
  if (tokens.reasoning !== null) out.push("reasoning")
  if (tokens.cache.read !== null) out.push("cache_read")
  if (tokens.cache.write !== null) out.push("cache_write")
  return out
}

export function assertTurnUsageRevision(fact: TurnUsageRevision) {
  const required = [
    fact.sessionRef,
    fact.sessionId,
    fact.messageId,
    fact.hostId,
    fact.harness,
    fact.providerId,
    fact.modelId,
  ]
  if (required.some((value) => !value.trim())) throw new Error("usage revision identifiers must be non-empty")
  if (!Number.isSafeInteger(fact.revision) || fact.revision < 1)
    throw new Error("usage revision must be a positive integer")
  if (!Number.isFinite(fact.observedAt) || fact.observedAt < 0) throw new Error("usage observedAt must be non-negative")
  for (const value of [
    fact.tokens.input,
    fact.tokens.output,
    fact.tokens.reasoning,
    fact.tokens.cache.read,
    fact.tokens.cache.write,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("usage token values must be non-negative integers or null")
    }
  }
}
