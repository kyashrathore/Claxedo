import { isJsonRecord, isNonEmptyString, isOneOf } from "../platform/runtime/lib/json"
import { storedSessionRef } from "../session/meta/shape"
import {
  assertTurnUsageRevision,
  readTurnUsageQuality,
  readTurnUsageTokens,
  TURN_USAGE_SETTLEMENTS,
  TURN_USAGE_STATUSES,
  type TurnUsageRevision,
  type UsageRevisionWriteResult,
} from "./contracts"

/** The session-authority action a cloud workspace runtime ships its usage revisions under. */
export const USAGE_REPORT_ACTION = "usage_report"

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
 * The plane's answer for one fact. `refused` is final: the fact names a turn
 * its session never admitted, or one whose producer has no account.
 */
export type UsageReportResult = { messageId: string; revision: number } & (
  | UsageRevisionWriteResult
  | { status: "refused"; code: "usage_owner_unresolved" }
)

export const USAGE_REPORT_RESULT_STATUSES = [
  "accepted",
  "duplicate",
  "stale",
  "conflict",
  "refused",
] as const satisfies readonly UsageReportResult["status"][]

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

/** A report's facts, or nothing when any one of them is malformed or names a field the plane owns. */
export function readUsageReportFacts(value: unknown): UsageReportFact[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const facts: UsageReportFact[] = []
  for (const item of value) {
    const fact = readUsageReportFact(item)
    if (!fact) return undefined
    facts.push(fact)
  }
  return facts
}
