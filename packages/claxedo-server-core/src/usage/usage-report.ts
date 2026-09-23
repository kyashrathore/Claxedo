import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import { isJsonRecord, isNonEmptyString, isOneOf } from "../platform/runtime/lib/json"
import { storedSessionRef } from "../session/meta/shape"
import {
  assertTurnUsageRevision,
  readTurnUsageQuality,
  TURN_USAGE_SETTLEMENTS,
  TURN_USAGE_STATUSES,
  type TurnUsageRevision,
} from "./contracts"

/** The session-authority action a cloud workspace runtime ships its usage revisions under. */
export const USAGE_REPORT_ACTION = "usage_report"

/**
 * What a runtime says about one revision. Session, workspace, host and
 * location are absent on purpose: the plane files a report under its own
 * verified proof, and a reported value for any of them is refused.
 */
export type UsageReportFact = Omit<TurnUsageRevision, "sessionRef" | "sessionId" | "workspaceId" | "hostId" | "location">

const REPORT_FACT_KEYS: ReadonlySet<string> = new Set([
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

export function usageReportFact(fact: TurnUsageRevision): UsageReportFact {
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
 * and workspace. Throws for a fact that is not a well-formed revision.
 */
export function cloudWorkspaceUsageRevision(
  fact: UsageReportFact,
  proof: { workspaceId: string; sessionId: string },
): TurnUsageRevision {
  const revision: TurnUsageRevision = { ...fact, sessionId: proof.sessionId, ...cloudWorkspaceUsageContext(proof) }
  assertTurnUsageRevision(revision)
  return revision
}

function tokenCount(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function readTokens(value: unknown): RuntimeTokenUsage | undefined {
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

function readUsageReportFact(value: unknown): UsageReportFact | undefined {
  if (!isJsonRecord(value) || Object.keys(value).some((key) => !REPORT_FACT_KEYS.has(key))) return undefined
  const tokens = readTokens(value.tokens)
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
