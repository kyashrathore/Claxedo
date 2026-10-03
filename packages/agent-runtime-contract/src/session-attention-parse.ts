import { asRecord, isNonNegativeSafeInteger } from "@claxedo/helpers/guards"
import type { SessionAttentionFacts, SessionReaderState } from "./session-attention"

const optionalPosition = (value: unknown) => value === undefined || isNonNegativeSafeInteger(value)

function assertSessionAttention(input: unknown): asserts input is SessionAttentionFacts {
  const row = asRecord(input)
  if (!row || !isNonNegativeSafeInteger(row.sequence) || !isNonNegativeSafeInteger(row.generation) || !isNonNegativeSafeInteger(row.activitySequence) || !isNonNegativeSafeInteger(row.activityAt)
    || row.generation === 0 || row.generation > row.activitySequence || row.activitySequence > row.sequence
    || typeof row.working !== "boolean" || typeof row.awaitingInput !== "boolean") throw new Error("Invalid session attention facts")
  const outcome = asRecord(row.outcome)
  if (row.outcome !== undefined && (!outcome || !isNonNegativeSafeInteger(outcome.sequence) || !isNonNegativeSafeInteger(outcome.completedAt)
    || outcome.sequence < row.generation || outcome.sequence > row.sequence
    || (outcome.status !== "completed" && outcome.status !== "failed" && outcome.status !== "cancelled"))) throw new Error("Invalid session outcome position")
}

function assertSessionReader(input: unknown): asserts input is SessionReaderState {
  const row = asRecord(input)
  if (!row || !isNonNegativeSafeInteger(row.generation) || !isNonNegativeSafeInteger(row.revision) || !isNonNegativeSafeInteger(row.seenThrough)
    || row.generation === 0 || (row.seenThrough > 0 && row.seenAt === undefined)
    || !optionalPosition(row.seenAt) || !optionalPosition(row.settledThrough) || !optionalPosition(row.settledAt)
    || (row.settledThrough === undefined) !== (row.settledAt === undefined)) throw new Error("Invalid session reader state")
}

export function parseSessionAttention(input: unknown): SessionAttentionFacts | undefined {
  if (input === undefined) return undefined
  assertSessionAttention(input)
  return input
}

export function parseSessionReader(input: unknown): SessionReaderState | undefined {
  if (input === undefined) return undefined
  assertSessionReader(input)
  return input
}
