import { isJsonRecord, isNonEmptyString, isOneOf } from "../platform/runtime/lib/json"
import { storedSessionRef } from "../session/meta/shape"
import {
  assertTurnUsageRevision,
  readTurnUsageQuality,
  readTurnUsageTokens,
  TURN_USAGE_SETTLEMENTS,
  TURN_USAGE_STATUSES,
  type TurnUsageRevision,
  type UsageOwner,
  type UsageRevisionWriteResult,
} from "./contracts"

/** The session-authority action a cloud workspace runtime ships its usage revisions under. */
export const USAGE_REPORT_ACTION = "usage_report"

/** The most facts one report carries; a report with more is refused whole. */
export const USAGE_REPORT_MAX_FACTS = 32

/** The longest message, turn, harness, provider, model or native session id a reported fact may carry. */
export const USAGE_REPORT_MAX_ID_LENGTH = 256

/**
 * The longest provider observation id or key. The meter keys a cumulative
 * observation by its spelled-out counters and ids, which runs past 256.
 */
export const USAGE_REPORT_MAX_OBSERVATION_KEY_LENGTH = 1_024

/**
 * How long before its lease's admission a reported fact may have been
 * observed. Usage metered while no turn held its session waits for that
 * session's next turn, which can come after the runtime slept between them.
 */
export const USAGE_REPORT_MAX_FACT_AGE_MS = 30 * 24 * 60 * 60_000

/** How far ahead of the plane's clock a runtime's clock may run. */
export const USAGE_REPORT_CLOCK_SKEW_MS = 5 * 60_000

/**
 * The most tokens one reported message may carry in any category. A turn of
 * 2,000 requests each reading a 1M-token context is 2 x 10^9; a count past
 * this is not usage, and summed it would overflow the plane's aggregates.
 */
export const USAGE_REPORT_MAX_TOKENS_PER_CATEGORY = 10_000_000_000

/**
 * The highest revision a reported message may carry. A higher one would
 * leave every later genuine revision of that message answered as stale.
 */
export const USAGE_REPORT_MAX_REVISION = 1_000_000

/** The most distinct messages the plane files under one turn of one session. */
export const USAGE_REPORT_MAX_MESSAGES_PER_TURN = 2_048

/**
 * What a runtime says about one revision. Session, workspace, host and
 * location are absent on purpose: the plane files a report under its own
 * verified proof, and a reported value for any of them is refused.
 */
export type UsageReportRevision = Omit<TurnUsageRevision, "sessionRef" | "sessionId" | "workspaceId" | "hostId" | "location">

/**
 * A reported revision and the turn it was metered under. The plane accepts
 * the turn only as one the report's verified session admitted, and files the
 * revision under that turn's producer whichever turn's lease carried it.
 */
export type UsageReportFact = UsageReportRevision & { turnId: string }

/**
 * Why the plane refused one fact, finally:
 * - `usage_owner_unresolved`: the fact names a turn its session never
 *   admitted, one whose producer has no account, or one on a workspace that
 *   is not a cloud workspace — a machine's usage stays on the machine.
 * - `usage_fact_out_of_bounds`: an id past its length cap, a token count or
 *   revision past its ceiling, or an observation time outside the report's
 *   window.
 * - `usage_turn_full`: its turn already has the most messages one turn files.
 */
export type UsageReportRefusal = "usage_owner_unresolved" | "usage_fact_out_of_bounds" | "usage_turn_full"

/** The plane's answer for one fact. */
export type UsageReportResult = { messageId: string; revision: number } & (
  | UsageRevisionWriteResult
  | { status: "refused"; code: UsageReportRefusal }
)

export const USAGE_REPORT_RESULT_STATUSES = [
  "accepted",
  "duplicate",
  "stale",
  "conflict",
  "refused",
] as const satisfies readonly UsageReportResult["status"][]

/**
 * A central store the plane files reported revisions into, each under the
 * account and the turn it resolved for it. A store that counts a turn's
 * messages refuses one past {@link USAGE_REPORT_MAX_MESSAGES_PER_TURN}.
 */
export type UsageReportWriter = {
  writeRevision(
    fact: TurnUsageRevision,
    filing: { owner: UsageOwner; turnId: string; admittedAt?: number },
  ): Promise<UsageRevisionWriteResult | { status: "refused"; code: "usage_turn_full" }>
}

const REPORT_REVISION_KEYS: ReadonlySet<string> = new Set([
  "messageId",
  "revision",
  "observedAt",
  "completedAt",
  "settlement",
  "status",
  "harness",
  "providerId",
  "modelId",
  "nativeSessionId",
  "tokens",
  "quality",
])

/**
 * Where a cloud workspace's usage is filed. The host is the workspace itself:
 * only a relay-host turn proof carries a host claim, and a revision's key must
 * not change with the proof that carried it, or one turn would count twice.
 */
export function cloudWorkspaceUsageContext(input: { workspaceId: string; sessionId: string }) {
  return {
    sessionRef: storedSessionRef({ session_id: input.sessionId, workspace_id: input.workspaceId }),
    workspaceId: input.workspaceId,
    hostId: `workspace:${input.workspaceId}`,
    location: "cloud-workspace" as const,
  }
}

export function usageReportRevision(fact: UsageReportRevision): UsageReportRevision {
  return {
    messageId: fact.messageId,
    revision: fact.revision,
    observedAt: fact.observedAt,
    ...(fact.completedAt === undefined ? {} : { completedAt: fact.completedAt }),
    settlement: fact.settlement,
    status: fact.status,
    harness: fact.harness,
    providerId: fact.providerId,
    modelId: fact.modelId,
    ...(fact.nativeSessionId ? { nativeSessionId: fact.nativeSessionId } : {}),
    tokens: fact.tokens,
    quality: fact.quality,
  }
}

/**
 * The revision a report stands for, filed under the plane's verified session
 * and workspace. A fact's turn decides who owns the revision, never what it
 * says. Throws for a fact that is not a well-formed revision.
 */
export function cloudWorkspaceUsageRevision(
  fact: UsageReportRevision,
  proof: { workspaceId: string; sessionId: string },
): TurnUsageRevision {
  const revision: TurnUsageRevision = {
    ...usageReportRevision(fact),
    sessionId: proof.sessionId,
    ...cloudWorkspaceUsageContext(proof),
  }
  assertTurnUsageRevision(revision)
  return revision
}

/**
 * Whether a well-formed fact is one the plane stores: every id within its
 * length cap, every token count and the revision within their ceilings, and
 * observed — and completed, if it says so — no earlier than
 * {@link USAGE_REPORT_MAX_FACT_AGE_MS} before the lease carrying it was
 * admitted and no later than {@link USAGE_REPORT_CLOCK_SKEW_MS} past `now`.
 */
export function usageReportFactInBounds(fact: UsageReportFact, window: { admittedAt: number; now: number }) {
  const ids = [fact.messageId, fact.turnId, fact.harness, fact.providerId, fact.modelId, fact.nativeSessionId ?? ""]
  const observationIds = [fact.quality.providerObservationId ?? "", fact.quality.providerObservationKey ?? ""]
  const { tokens } = fact
  const counts = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write, tokens.cache.write1h ?? null]
  const earliest = window.admittedAt - USAGE_REPORT_MAX_FACT_AGE_MS
  const latest = window.now + USAGE_REPORT_CLOCK_SKEW_MS
  const inWindow = (at: number) => at >= earliest && at <= latest
  return ids.every((id) => id.length <= USAGE_REPORT_MAX_ID_LENGTH)
    && observationIds.every((id) => id.length <= USAGE_REPORT_MAX_OBSERVATION_KEY_LENGTH)
    && counts.every((count) => count === null || count <= USAGE_REPORT_MAX_TOKENS_PER_CATEGORY)
    && fact.revision <= USAGE_REPORT_MAX_REVISION
    && inWindow(fact.observedAt)
    && (fact.completedAt === undefined || inWindow(fact.completedAt))
}

/** A reported revision, or nothing when it is malformed or names a field the plane owns. */
export function readUsageReportRevision(value: unknown): UsageReportRevision | undefined {
  if (!isJsonRecord(value) || Object.keys(value).some((key) => !REPORT_REVISION_KEYS.has(key))) return undefined
  const tokens = readTurnUsageTokens(value.tokens)
  const { messageId, revision, observedAt, completedAt, settlement, status, harness, providerId, modelId, nativeSessionId } = value
  if (
    !tokens
    || !isNonEmptyString(messageId)
    || typeof revision !== "number"
    || typeof observedAt !== "number"
    || (completedAt !== undefined && typeof completedAt !== "number")
    || !isOneOf(settlement, TURN_USAGE_SETTLEMENTS)
    || !isOneOf(status, TURN_USAGE_STATUSES)
    || !isNonEmptyString(harness)
    || !isNonEmptyString(providerId)
    || !isNonEmptyString(modelId)
    || (nativeSessionId !== undefined && !isNonEmptyString(nativeSessionId))
    || !isJsonRecord(value.quality)
  ) return undefined
  return {
    messageId,
    revision,
    observedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    settlement,
    status,
    harness,
    providerId,
    modelId,
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    tokens,
    quality: readTurnUsageQuality(value.quality),
  }
}

function readUsageReportFact(value: unknown): UsageReportFact | undefined {
  if (!isJsonRecord(value)) return undefined
  const { turnId, ...reported } = value
  const revision = readUsageReportRevision(reported)
  return revision && isNonEmptyString(turnId) ? { ...revision, turnId } : undefined
}

/**
 * A report's facts, or nothing when there are none, more than
 * {@link USAGE_REPORT_MAX_FACTS}, or any one of them is malformed or names a
 * field the plane owns.
 */
export function readUsageReportFacts(value: unknown): UsageReportFact[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > USAGE_REPORT_MAX_FACTS) return undefined
  const facts: UsageReportFact[] = []
  for (const item of value) {
    const fact = readUsageReportFact(item)
    if (!fact) return undefined
    facts.push(fact)
  }
  return facts
}
