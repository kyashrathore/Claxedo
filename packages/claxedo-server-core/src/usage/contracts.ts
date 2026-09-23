import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import { isJsonRecord, isNonEmptyString, isOneOf } from "../platform/runtime/lib/json"

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

function canonicalTokens(tokens: TurnUsageRevision["tokens"]): TurnUsageRevision["tokens"] {
  const write1h = tokens.cache.write1h
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    // A one-hour split that is null has no column value a stored row can give back.
    cache: {
      read: tokens.cache.read,
      write: tokens.cache.write,
      ...(write1h === null || write1h === undefined ? {} : { write1h }),
    },
  }
}

function canonicalQuality(quality: TurnUsageQuality): TurnUsageQuality {
  return {
    source: quality.source,
    ...(quality.observationKind === undefined ? {} : { observationKind: quality.observationKind }),
    ...(quality.providerObservationId === undefined ? {} : { providerObservationId: quality.providerObservationId }),
    ...(quality.providerObservationKey === undefined ? {} : { providerObservationKey: quality.providerObservationKey }),
    knownCategories: TURN_USAGE_TOKEN_CATEGORIES.filter((category) => quality.knownCategories.includes(category)),
  }
}

/**
 * The payload identity every usage store compares a replayed revision by.
 * Every key, nested ones included, is written in one order here whatever
 * order the caller built the fact in, so two stores hashing the same fact
 * agree on `duplicate` versus `conflict`.
 */
export async function usageRevisionHash(fact: TurnUsageRevision): Promise<string> {
  const canonical = JSON.stringify({
    hostId: fact.hostId,
    sessionRef: fact.sessionRef,
    sessionId: fact.sessionId,
    messageId: fact.messageId,
    revision: fact.revision,
    observedAt: fact.observedAt,
    completedAt: fact.completedAt ?? null,
    settlement: fact.settlement,
    status: fact.status,
    location: fact.location,
    harness: fact.harness,
    providerId: fact.providerId,
    modelId: fact.modelId,
    nativeSessionId: fact.nativeSessionId ?? null,
    workspaceId: fact.workspaceId ?? null,
    tokens: canonicalTokens(fact.tokens),
    quality: canonicalQuality(fact.quality),
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export type UsageRevisionWriteResult =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "stale"; currentRevision: number }
  | { status: "conflict"; currentRevision: number }

/**
 * The account that produced a turn. It is not fact content: the composition
 * resolves it from the session's producing identity, never from a later
 * request, and it stays out of `TurnUsageRevision` so attribution can never
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
}

export type UsageOwnedTurnReader = {
  /** The latest revision of every turn `owner` produced and observed in [since, until]. */
  ownedBy(owner: UsageOwner, range?: { since?: number; until?: number }): Promise<TurnUsageRevision[]>
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
    fact.tokens.cache.write1h ?? null,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("usage token values must be non-negative integers or null")
    }
  }
  const write1h = fact.tokens.cache.write1h ?? null
  if (write1h !== null && write1h > (fact.tokens.cache.write ?? 0)) {
    throw new Error("usage one-hour cache writes cannot exceed cache writes")
  }
}

function tokenCount(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A revision's token counts read from JSON, or nothing when one is not a count or `null`. */
export function readTurnUsageTokens(value: unknown): RuntimeTokenUsage | undefined {
  if (!isJsonRecord(value) || !isJsonRecord(value.cache)) return undefined
  const input = tokenCount(value.input)
  const output = tokenCount(value.output)
  const reasoning = tokenCount(value.reasoning)
  const read = tokenCount(value.cache.read)
  const write = tokenCount(value.cache.write)
  const write1h = value.cache.write1h === undefined ? null : tokenCount(value.cache.write1h)
  if ([input, output, reasoning, read, write, write1h].some((count) => count === undefined)) return undefined
  return {
    input: input ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    cache: { read: read ?? null, write: write ?? null, ...(write1h === null || write1h === undefined ? {} : { write1h }) },
  }
}

const REVISION_KEYS: ReadonlySet<string> = new Set<keyof TurnUsageRevision>([
  "sessionRef",
  "sessionId",
  "messageId",
  "revision",
  "observedAt",
  "completedAt",
  "settlement",
  "status",
  "location",
  "harness",
  "providerId",
  "modelId",
  "nativeSessionId",
  "workspaceId",
  "hostId",
  "tokens",
  "quality",
])

/**
 * A revision that crossed a JSON boundary, or nothing when it is not one. The
 * revision is the privacy boundary, so nothing else a sender put in it is
 * carried: a top-level field the contract does not name refuses the whole
 * revision, and inside `tokens` and `quality` only the named fields are read.
 */
export function readTurnUsageRevision(value: unknown): TurnUsageRevision | undefined {
  if (!isJsonRecord(value) || Object.keys(value).some((key) => !REVISION_KEYS.has(key))) return undefined
  const tokens = readTurnUsageTokens(value.tokens)
  const {
    sessionRef, sessionId, messageId, revision, observedAt, completedAt, settlement, status, location,
    harness, providerId, modelId, nativeSessionId, workspaceId, hostId,
  } = value
  if (
    !tokens
    || !isNonEmptyString(sessionRef)
    || !isNonEmptyString(sessionId)
    || !isNonEmptyString(messageId)
    || typeof revision !== "number"
    || typeof observedAt !== "number"
    || (completedAt !== undefined && typeof completedAt !== "number")
    || !isOneOf(settlement, TURN_USAGE_SETTLEMENTS)
    || !isOneOf(status, TURN_USAGE_STATUSES)
    || !isOneOf(location, TURN_USAGE_LOCATIONS)
    || !isNonEmptyString(harness)
    || !isNonEmptyString(providerId)
    || !isNonEmptyString(modelId)
    || (nativeSessionId !== undefined && !isNonEmptyString(nativeSessionId))
    || (workspaceId !== undefined && !isNonEmptyString(workspaceId))
    || !isNonEmptyString(hostId)
    || !isJsonRecord(value.quality)
  ) return undefined
  const fact: TurnUsageRevision = {
    sessionRef,
    sessionId,
    messageId,
    revision,
    observedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    settlement,
    status,
    location,
    harness,
    providerId,
    modelId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    hostId,
    tokens,
    quality: readTurnUsageQuality(value.quality),
  }
  try {
    assertTurnUsageRevision(fact)
  } catch {
    return undefined
  }
  return fact
}
