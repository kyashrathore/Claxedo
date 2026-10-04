import { asRecord, asText } from "../values"
import { RecoveryContractError, member, requireRecoveryText, requireRecoveryNumber } from "./validation"

/**
 * The owner's identity on the wire and across a restart. The in-process object
 * generation is a different value and is never sent: it cannot survive the
 * process that minted it, so a stale caller could not be told apart from a
 * replacement one.
 */
export type RecoveryGeneration = string

export const EXECUTION_FACTS = ["running", "terminal", "unknown"] as const

export const CLEANUP_FACTS = ["owned", "verified_clear", "unknown"] as const

export const PERSISTENCE_FACTS = ["committed", "pending", "unavailable"] as const

export type ExecutionFact = (typeof EXECUTION_FACTS)[number]

export type CleanupFact = (typeof CLEANUP_FACTS)[number]

export type PersistenceFact = (typeof PERSISTENCE_FACTS)[number]

/** `observedAt` is epoch milliseconds; the wire carries no Date. */
export type RecoveryFactEvidence<V extends string> = {
  value: V
  source: string
  observedAt: number
  generation: RecoveryGeneration
}

/**
 * Execution, cleanup and persistence are three fields rather than one status
 * because they are three independent events: a provider can confirm
 * cancellation while a turn-owned child survives, and an exited process group
 * can still fail to finalize in SQLite. A single boolean outcome can let a
 * timed-out stop read as success and admit conflicting work.
 *
 * Session availability is deliberately absent. `AgentRuntimeStatus`
 * and `ExecutionAvailability` remain the only session-status authority; a
 * recovery operation's state describes the command, not the transcript.
 */
export type RecoveryFacts = {
  execution: RecoveryFactEvidence<ExecutionFact>
  cleanup: RecoveryFactEvidence<CleanupFact>
  persistence: RecoveryFactEvidence<PersistenceFact>
}

export function parseRecoveryFacts(input: unknown): RecoveryFacts {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_fact", "recovery facts must be an object")
  return {
    execution: parseFact(row.execution, EXECUTION_FACTS, "execution"),
    cleanup: parseFact(row.cleanup, CLEANUP_FACTS, "cleanup"),
    persistence: parseFact(row.persistence, PERSISTENCE_FACTS, "persistence"),
  }
}

function parseFact<V extends string>(
  input: unknown,
  values: readonly V[],
  label: string,
): RecoveryFactEvidence<V> {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_fact", `recovery ${label} fact must be an object`)
  if (!member(values, row.value)) {
    throw new RecoveryContractError("invalid_fact", `unknown recovery ${label} value ${JSON.stringify(row.value)}`)
  }
  const generation = asText(row.generation)
  if (generation === undefined) {
    throw new RecoveryContractError("missing_generation", `recovery ${label} fact generation is required`)
  }
  return {
    value: row.value,
    source: requireRecoveryText(row.source, "invalid_fact", `${label} source`),
    observedAt: requireRecoveryNumber(row.observedAt, "invalid_observed_at", `${label} observedAt`),
    generation,
  }
}
