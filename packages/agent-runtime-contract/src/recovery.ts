/**
 * Wire types for recovery operations: what a caller asks an owner to do, what
 * the owner answers, and the evidence behind that answer.
 *
 * Execution, cleanup and persistence are three fields rather than one status
 * because they are three independent events: a provider can confirm
 * cancellation while a turn-owned child survives, and an exited process group
 * can still fail to finalize in SQLite. A single boolean outcome is what let a
 * timed-out stop read as success and admit conflicting work.
 *
 * Session availability is deliberately absent. `AgentRuntimeStatus.recovering`
 * and `ExecutionAvailability` remain the only session-status authority; a
 * recovery operation's state describes the command, not the transcript.
 */

import { asFiniteNumber } from "@claxedo/helpers/guards"
import { asRecord, asText } from "./values"

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

export type RecoveryFacts = {
  execution: RecoveryFactEvidence<ExecutionFact>
  cleanup: RecoveryFactEvidence<CleanupFact>
  persistence: RecoveryFactEvidence<PersistenceFact>
}

/**
 * The redacted ownership view a machine owner republishes beside its discovery
 * record, and the age past which a reader must treat it as stale.
 *
 * Both halves live here because the writer and the reader are in different
 * products with a boundary between them: the launcher that reads this file
 * cannot import the daemon that writes it, and a filename agreed twice is a
 * filename that drifts once.
 */
export const DAEMON_OWNERSHIP_SNAPSHOT_FILE = "local-daemon-ownership.json"
export const DAEMON_OWNERSHIP_SNAPSHOT_STALE_MS = 10_000

/** The snapshot's path under a daemon data root, for the writer and the reader alike. */
export function daemonOwnershipSnapshotPath(dataRoot: string): string {
  return `${dataRoot.replace(/[/\\]+$/, "")}/${DAEMON_OWNERSHIP_SNAPSHOT_FILE}`
}

/** One owner row as the snapshot carries it: ids, states and generations, never a command. */
export type DaemonOwnershipRow = {
  id: string
  kind: string
  generation: string
  state: string
  pins: boolean
  detail?: string
}

/**
 * What a launcher may rely on in a snapshot it did not write.
 *
 * Both sides validate through this rather than each declaring the shape: the
 * writer is a daemon and the reader is the launcher that cannot import it, so
 * two declarations would be two chances to drift.
 */
export function isDaemonOwnershipSnapshot(value: unknown): value is {
  machineId: string
  generation: string
  pid: number
  revision: string
  writtenAt: number
  residencyPins: number
  owners: DaemonOwnershipRow[]
} {
  const row = asRecord(value)
  return (
    !!row
    && text(row.machineId) && text(row.generation) && text(row.revision)
    && typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.writtenAt === "number" && Number.isFinite(row.writtenAt)
    && typeof row.residencyPins === "number" && Number.isFinite(row.residencyPins)
    && Array.isArray(row.owners)
    && row.owners.every((owner) => {
      const entry = asRecord(owner)
      return !!entry && text(entry.id) && text(entry.kind) && text(entry.generation)
        && text(entry.state) && typeof entry.pins === "boolean"
    })
  )
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export const RECOVERY_TARGET_SCOPES = ["turn", "session", "harness", "machine"] as const
export type RecoveryTargetScope = (typeof RECOVERY_TARGET_SCOPES)[number]

export type RecoveryTurnTarget = {
  scope: "turn"
  machineId?: string
  workspaceId: string
  sessionId: string
  turnId: string
  ownerGeneration: RecoveryGeneration
  /** The durable lease or token id whose holder may write for this target. */
  writeAuthority?: string
}

export type RecoverySessionTarget = {
  scope: "session"
  machineId?: string
  workspaceId: string
  sessionId: string
  ownerGeneration: RecoveryGeneration
}

export type RecoveryHarnessTarget = {
  scope: "harness"
  machineId?: string
  workspaceId: string
  /** The harness generation's own key; a harness may serve several sessions. */
  harnessKey: string
  ownerGeneration: RecoveryGeneration
}

export type RecoveryMachineTarget = {
  scope: "machine"
  machineId: string
  ownerGeneration: RecoveryGeneration
}

/**
 * The scopes carry different fields because they name different things: a
 * daemon has no session and a harness generation outlives any one turn.
 * Flattening them would make a caller invent a session id to drain a daemon,
 * and an invented identity is indistinguishable from a real one downstream.
 */
export type RecoveryTarget =
  | RecoveryTurnTarget
  | RecoverySessionTarget
  | RecoveryHarnessTarget
  | RecoveryMachineTarget

export const RECOVERY_ACTIONS = [
  "inspect",
  "cancel_turn",
  "reconcile_session",
  "retire_harness",
  "drain_daemon",
  "stop_daemon",
  "release_drain",
] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export const RECOVERY_MUTATING_ACTIONS = [
  "cancel_turn",
  "reconcile_session",
  "retire_harness",
  "drain_daemon",
  "stop_daemon",
  "release_drain",
] as const
export type RecoveryMutatingAction = (typeof RECOVERY_MUTATING_ACTIONS)[number]

/**
 * `read_operation` reads an existing operation by id, so it is not itself a
 * `RecoveryAction`: it has no target, no scope and no receipt of its own.
 */
export const RECOVERY_READ_ACTIONS = ["inspect", "read_operation"] as const
export type RecoveryReadAction = (typeof RECOVERY_READ_ACTIONS)[number]

export function isMutatingRecoveryAction(action: RecoveryAction): action is RecoveryMutatingAction {
  return member(RECOVERY_MUTATING_ACTIONS, action)
}

/**
 * Which target an action may name. `reconcile_session` accepts a turn so a
 * caller can narrow reconciliation to one turn of a session; every other
 * action has exactly the owner its postcondition is written against.
 */
export const RECOVERY_ACTION_SCOPES: Readonly<Record<RecoveryAction, readonly RecoveryTargetScope[]>> = {
  inspect: RECOVERY_TARGET_SCOPES,
  cancel_turn: ["turn"],
  reconcile_session: ["session", "turn"],
  retire_harness: ["harness"],
  drain_daemon: ["machine"],
  stop_daemon: ["machine"],
  release_drain: ["machine"],
}

/**
 * The drain a `release_drain` reopens, by operation id.
 *
 * Releasing is always about one earlier operation's gates, never about "the
 * fence" in general: two drains can hold overlapping owners, and reopening
 * whatever happens to be closed would un-gate a scope its own caller never
 * authorized reopening. The id rides in `linkedOperationId`, which is the field
 * for exactly this — a request that names another operation — so a release
 * without one is refused before it reaches an owner.
 */
export function releasedDrainOperationId(request: RecoveryRequest): string | undefined {
  return request.action === "release_drain" ? request.linkedOperationId : undefined
}

export type RecoveryRequest = {
  /** Unique per caller, not globally: two callers may reuse the same string. */
  requestId: string
  action: RecoveryAction
  target: RecoveryTarget
  /** The revision of the impact scope the caller was shown and authorized. */
  scopeRevision: string
  attempt: number
  /** The failed operation an explicit retry, or a nested child, is linked to. */
  linkedOperationId?: string
}

/**
 * The part of a request that decides whether a second delivery of the same
 * request id is the same command. Attempt and request id are excluded: a retry
 * is a new attempt of one intent, and the id is the key being compared under.
 */
export type RecoveryIntent = {
  action: RecoveryAction
  scopeRevision: string
  target: RecoveryTarget
  linkedOperationId?: string
}

export const RECOVERY_OPERATION_STATES = ["accepted", "running", "succeeded", "failed", "needs_action"] as const
export type RecoveryOperationState = (typeof RECOVERY_OPERATION_STATES)[number]

export const RECOVERY_PHASES = [
  "ack",
  "provider_query",
  "graceful_cancel",
  "term_grace",
  "kill_verify",
  "reconcile",
  "drain",
] as const
export type RecoveryPhase = (typeof RECOVERY_PHASES)[number]

/** A volatile receipt was never durably recorded and never survives a restart. */
export type RecoveryReceipt = "durable" | "volatile"

export type RecoveryNextAction = {
  action: RecoveryAction
  scopePreviewRequired: boolean
  reason: string
}

export const RECOVERY_ERROR_CODES = [
  "provider_unreachable",
  "cancellation_unsupported",
  "cancellation_timeout",
  "signal_denied",
  "exit_unverified",
  "ownership_unverified",
  "persistence_unavailable",
  "projection_failed",
  "generation_retired",
  "authority_lost",
  "deadline_exceeded",
  "owner_unavailable",
  "internal_error",
] as const
export type RecoveryErrorCode = (typeof RECOVERY_ERROR_CODES)[number]

/**
 * `message` is the whole public payload by construction: there is no free-form
 * details field, so a credential or a raw tool argument has nowhere to ride
 * out to a caller.
 */
export type RecoveryError = {
  code: RecoveryErrorCode
  /** The owner that reported it, by its own name. */
  origin: string
  target: RecoveryTarget
  stage: RecoveryPhase
  executionMayContinue: boolean
  message: string
  at: number
}

export type RecoveryOperation = {
  operationId: string
  requestId: string
  target: RecoveryTarget
  action: RecoveryAction
  scopeRevision: string
  attempt: number
  state: RecoveryOperationState
  phase: RecoveryPhase
  phaseDeadlineAt: number
  facts: RecoveryFacts
  initiatingError?: RecoveryError
  cleanupErrors: RecoveryError[]
  nextActions: RecoveryNextAction[]
  receipt: RecoveryReceipt
  linkedOperationId?: string
  createdAt: number
  updatedAt: number
}

/** The sessions and resources an escalation would interrupt, named individually. */
export type RecoveryScopePreview = {
  sessions: string[]
  resources: string[]
  summary: string
}

export type RecoveryRefusal =
  | { kind: "generation_conflict"; message: string; current?: RecoveryTarget }
  | { kind: "intent_conflict"; message: string; requestId: string }
  | { kind: "receipt_expired"; message: string; requestId: string }
  | { kind: "scope_changed"; message: string; scopeRevision: string; preview: RecoveryScopePreview }
  | { kind: "unauthorized"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "version_update_required"; message: string; contractVersion: number }

export type RecoveryOutcome =
  | { kind: "operation"; operation: RecoveryOperation }
  | { kind: "refused"; refusal: RecoveryRefusal }

export type RecoveryBudgets = {
  ackMs: number
  providerQueryMs: number
  gracefulCancelMs: number
  termGraceMs: number
  killVerifyMs: number
  reconcileMs: number
  drainMs: number
}

export const DEFAULT_RECOVERY_BUDGETS: Readonly<RecoveryBudgets> = {
  ackMs: 2000,
  providerQueryMs: 5000,
  gracefulCancelMs: 10000,
  termGraceMs: 3000,
  killVerifyMs: 2000,
  reconcileMs: 30000,
  drainMs: 30000,
}

/**
 * How long a settled recovery operation stays listed and stored. Ten reconcile
 * budgets: long enough that a caller which lost its connection can still read
 * its own receipt, short enough that the list is current work. An operation
 * whose facts still show cleanup owned or unknown, or persistence pending, is
 * exempt at every layer: it is the only record of an undischarged obligation.
 */
export const RECOVERY_OPERATION_RETENTION_MS = DEFAULT_RECOVERY_BUDGETS.reconcileMs * 10

/**
 * The deadline a child phase may run to. The parent caps it, so a sequence of
 * child phases cannot multiply the deadline the caller was promised. An already
 * expired parent yields `now`, which every phase treats as no time left.
 */
export function capChildBudget(parentDeadlineAt: number, childMs: number, now: number): number {
  requireRecoveryNumber(parentDeadlineAt, "invalid_budget", "parentDeadlineAt")
  requireRecoveryNumber(childMs, "invalid_budget", "childMs")
  requireRecoveryNumber(now, "invalid_budget", "now")
  if (childMs < 0) throw new RecoveryContractError("invalid_budget", "recovery child budget must not be negative")
  return Math.max(now, Math.min(parentDeadlineAt, now + childMs))
}

type RecoveryPostcondition = {
  execution?: ExecutionFact
  cleanup?: CleanupFact
  persistence?: PersistenceFact
}

/**
 * What each action advertises when it reports `succeeded`. Inspection asserts
 * nothing about the target, so it can succeed over a running turn; an emergency
 * daemon stop cannot promise a commit, because exiting may lose observations
 * that were never written.
 *
 * `release_drain` asserts nothing either, and for the opposite reason to
 * inspection: it reopens a gate, so its postcondition is about the gate rather
 * than about the target. Requiring `terminal` would make a successful release
 * impossible by construction — the machine it reopens is one that is still
 * running work, which is the whole point of releasing instead of stopping.
 */
const RECOVERY_POSTCONDITIONS: Readonly<Record<RecoveryAction, RecoveryPostcondition>> = {
  inspect: {},
  cancel_turn: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  reconcile_session: { persistence: "committed" },
  retire_harness: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  drain_daemon: { execution: "terminal", cleanup: "verified_clear", persistence: "committed" },
  stop_daemon: { execution: "terminal", cleanup: "verified_clear" },
  release_drain: {},
}

export function recoveryPostconditionHolds(action: RecoveryAction, facts: RecoveryFacts): boolean {
  const required = RECOVERY_POSTCONDITIONS[action]
  return (required.execution === undefined || facts.execution.value === required.execution)
    && (required.cleanup === undefined || facts.cleanup.value === required.cleanup)
    && (required.persistence === undefined || facts.persistence.value === required.persistence)
}

/**
 * Whether the turn is over and the record of it is durable: the postcondition a
 * dependent mutation waits on, and the only honest reading of "it stopped".
 *
 * The operation's state is not that test. `cancel_turn` additionally requires
 * `cleanup: verified_clear` to reach `succeeded`, which an adapter reports only
 * when it can prove nothing the turn started survives; a harness that cannot
 * prove it leaves cleanup `unknown`, so a working cancellation closes as
 * `needs_action`. Reading that as "did not stop" marks every healthy Stop a
 * failure and blocks the revert, undo and handoff that need only the turn to be
 * over and written down. Cleanup stays a separate fact rather than a weaker
 * form of this one.
 */
/**
 * Marks the line carrying a recovery tool's JSON payload.
 *
 * A tool answers in two parts — a sentence a person reads, then the payload a
 * renderer decodes — and they arrive joined into one string. Without a marker a
 * reader has to guess where the prose stops, and the first guess (the first
 * line opening a brace) silently lost the payload as soon as the prose above it
 * changed shape.
 */
export const RECOVERY_PAYLOAD_PREFIX = "recovery-payload: "

/** The payload a recovery tool marked, or nothing when the text carries none. */
export function readRecoveryPayloadLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(RECOVERY_PAYLOAD_PREFIX)) return trimmed.slice(RECOVERY_PAYLOAD_PREFIX.length)
  }
  return undefined
}

export function turnStopped(outcome: RecoveryOutcome): boolean {
  return outcome.kind === "operation"
    && outcome.operation.facts.execution.value === "terminal"
    && outcome.operation.facts.persistence.value === "committed"
}

/**
 * Applies the latest evidence to an attempt. A terminal attempt keeps its
 * state: later evidence corrects the facts, but an attempt that timed out is
 * not rewritten into a success.
 */
export function finalizeRecoveryOperation(operation: RecoveryOperation, facts: RecoveryFacts): RecoveryOperation {
  const updatedAt = Math.max(
    operation.updatedAt,
    facts.execution.observedAt,
    facts.cleanup.observedAt,
    facts.persistence.observedAt,
  )
  if (operation.state === "succeeded" || operation.state === "failed") return { ...operation, facts, updatedAt }
  if (recoveryPostconditionHolds(operation.action, facts)) return { ...operation, facts, updatedAt, state: "succeeded" }
  const known = operation.initiatingError !== undefined || operation.cleanupErrors.length > 0
  return { ...operation, facts, updatedAt, state: known ? "failed" : "needs_action" }
}

/**
 * Key order comes from the literals here rather than from the caller's object,
 * so `JSON.stringify` of the result is canonical and can be stored as the
 * column an owner compares a repeated request id against.
 */
export function normalizeRecoveryIntent(request: RecoveryRequest): RecoveryIntent {
  return {
    action: request.action,
    scopeRevision: request.scopeRevision,
    target: normalizeRecoveryTarget(request.target),
    ...(request.linkedOperationId !== undefined ? { linkedOperationId: request.linkedOperationId } : {}),
  }
}

export function normalizeRecoveryTarget(target: RecoveryTarget): RecoveryTarget {
  if (target.scope === "machine") {
    return { scope: "machine", machineId: target.machineId, ownerGeneration: target.ownerGeneration }
  }
  const machine = target.machineId !== undefined ? { machineId: target.machineId } : {}
  if (target.scope === "harness") {
    return {
      scope: "harness",
      ...machine,
      workspaceId: target.workspaceId,
      harnessKey: target.harnessKey,
      ownerGeneration: target.ownerGeneration,
    }
  }
  if (target.scope === "session") {
    return {
      scope: "session",
      ...machine,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      ownerGeneration: target.ownerGeneration,
    }
  }
  return {
    scope: "turn",
    ...machine,
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    turnId: target.turnId,
    ownerGeneration: target.ownerGeneration,
    ...(target.writeAuthority !== undefined ? { writeAuthority: target.writeAuthority } : {}),
  }
}

/**
 * Whether two targets name the same resource under the same owner generation.
 * `writeAuthority` is excluded: a lease may be renewed or reissued for the very
 * turn a caller is checking, so comparing it would call a live target stale.
 */
export function recoveryTargetsMatch(a: RecoveryTarget, b: RecoveryTarget): boolean {
  return JSON.stringify(targetIdentity(a)) === JSON.stringify(targetIdentity(b))
}

function targetIdentity(target: RecoveryTarget): unknown[] {
  const machine = target.machineId ?? null
  if (target.scope === "machine") return ["machine", machine, target.ownerGeneration]
  if (target.scope === "harness") {
    return ["harness", machine, target.workspaceId, target.harnessKey, target.ownerGeneration]
  }
  if (target.scope === "session") {
    return ["session", machine, target.workspaceId, target.sessionId, target.ownerGeneration]
  }
  return ["turn", machine, target.workspaceId, target.sessionId, target.turnId, target.ownerGeneration]
}

/** The comparison an owner makes when one request id arrives twice. */
export function recoveryIntentEquals(a: RecoveryRequest, b: RecoveryRequest): boolean {
  return JSON.stringify(normalizeRecoveryIntent(a)) === JSON.stringify(normalizeRecoveryIntent(b))
}

export const RECOVERY_CONTRACT_ERROR_CODES = [
  "invalid_payload",
  "invalid_request_id",
  "invalid_action",
  "invalid_attempt",
  "invalid_scope_revision",
  "invalid_target",
  "invalid_target_scope",
  "scope_mismatch",
  "missing_generation",
  "invalid_observed_at",
  "invalid_fact",
  "invalid_operation",
  "invalid_refusal",
  "invalid_budget",
] as const
export type RecoveryContractErrorCode = (typeof RECOVERY_CONTRACT_ERROR_CODES)[number]

export class RecoveryContractError extends Error {
  constructor(readonly code: RecoveryContractErrorCode, message: string) {
    super(message)
    this.name = "RecoveryContractError"
  }
}

export function parseRecoveryTarget(input: unknown): RecoveryTarget {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_target", "recovery target must be an object")
  if (!member(RECOVERY_TARGET_SCOPES, row.scope)) {
    throw new RecoveryContractError("invalid_target_scope", `unknown recovery target scope ${JSON.stringify(row.scope)}`)
  }
  const ownerGeneration = asText(row.ownerGeneration)
  if (ownerGeneration === undefined) {
    throw new RecoveryContractError("missing_generation", "recovery target ownerGeneration is required")
  }
  if (row.scope === "machine") {
    return {
      scope: "machine",
      machineId: requireRecoveryText(row.machineId, "invalid_target", "machineId"),
      ownerGeneration,
    }
  }
  const machine = row.machineId !== undefined
    ? { machineId: requireRecoveryText(row.machineId, "invalid_target", "machineId") }
    : {}
  const workspaceId = requireRecoveryText(row.workspaceId, "invalid_target", "workspaceId")
  if (row.scope === "harness") {
    return {
      scope: "harness",
      ...machine,
      workspaceId,
      harnessKey: requireRecoveryText(row.harnessKey, "invalid_target", "harnessKey"),
      ownerGeneration,
    }
  }
  const sessionId = requireRecoveryText(row.sessionId, "invalid_target", "sessionId")
  if (row.scope === "session") return { scope: "session", ...machine, workspaceId, sessionId, ownerGeneration }
  return {
    scope: "turn",
    ...machine,
    workspaceId,
    sessionId,
    turnId: requireRecoveryText(row.turnId, "invalid_target", "turnId"),
    ownerGeneration,
    ...(row.writeAuthority !== undefined ? { writeAuthority: requireRecoveryText(row.writeAuthority, "invalid_target", "writeAuthority") } : {}),
  }
}

export function parseRecoveryRequest(input: unknown): RecoveryRequest {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery request must be an object")
  const requestId = asText(row.requestId)
  if (requestId === undefined) throw new RecoveryContractError("invalid_request_id", "recovery requestId is required")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  const attempt = row.attempt
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new RecoveryContractError("invalid_attempt", "recovery attempt must be an integer of at least 1")
  }
  const target = scopedTarget(row.action, row.target)
  return {
    requestId,
    action: row.action,
    target,
    scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
    attempt,
    ...(row.linkedOperationId !== undefined
      ? { linkedOperationId: requireRecoveryText(row.linkedOperationId, "invalid_operation", "linkedOperationId") }
      : {}),
  }
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

export function parseRecoveryError(input: unknown): RecoveryError {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery error must be an object")
  if (!member(RECOVERY_ERROR_CODES, row.code)) {
    throw new RecoveryContractError("invalid_payload", `unknown recovery error code ${JSON.stringify(row.code)}`)
  }
  if (!member(RECOVERY_PHASES, row.stage)) {
    throw new RecoveryContractError("invalid_payload", `unknown recovery stage ${JSON.stringify(row.stage)}`)
  }
  if (typeof row.executionMayContinue !== "boolean") {
    throw new RecoveryContractError("invalid_payload", "recovery error executionMayContinue is required")
  }
  return {
    code: row.code,
    origin: requireRecoveryText(row.origin, "invalid_payload", "origin"),
    target: parseRecoveryTarget(row.target),
    stage: row.stage,
    executionMayContinue: row.executionMayContinue,
    message: requireRecoveryText(row.message, "invalid_payload", "message"),
    at: requireRecoveryNumber(row.at, "invalid_observed_at", "at"),
  }
}

export function parseRecoveryOperation(input: unknown): RecoveryOperation {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_operation", "recovery operation must be an object")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  if (!member(RECOVERY_OPERATION_STATES, row.state)) {
    throw new RecoveryContractError("invalid_operation", `unknown recovery state ${JSON.stringify(row.state)}`)
  }
  if (!member(RECOVERY_PHASES, row.phase)) {
    throw new RecoveryContractError("invalid_operation", `unknown recovery phase ${JSON.stringify(row.phase)}`)
  }
  if (row.receipt !== "durable" && row.receipt !== "volatile") {
    throw new RecoveryContractError("invalid_operation", `unknown recovery receipt ${JSON.stringify(row.receipt)}`)
  }
  const attempt = row.attempt
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) {
    throw new RecoveryContractError("invalid_attempt", "recovery attempt must be an integer of at least 1")
  }
  if (!Array.isArray(row.cleanupErrors) || !Array.isArray(row.nextActions)) {
    throw new RecoveryContractError("invalid_operation", "recovery cleanupErrors and nextActions are required arrays")
  }
  return {
    operationId: requireRecoveryText(row.operationId, "invalid_operation", "operationId"),
    requestId: requireRecoveryText(row.requestId, "invalid_request_id", "requestId"),
    target: scopedTarget(row.action, row.target),
    action: row.action,
    scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
    attempt,
    state: row.state,
    phase: row.phase,
    phaseDeadlineAt: requireRecoveryNumber(row.phaseDeadlineAt, "invalid_observed_at", "phaseDeadlineAt"),
    facts: parseRecoveryFacts(row.facts),
    ...(row.initiatingError !== undefined ? { initiatingError: parseRecoveryError(row.initiatingError) } : {}),
    cleanupErrors: row.cleanupErrors.map(parseRecoveryError),
    nextActions: row.nextActions.map(parseNextAction),
    receipt: row.receipt,
    ...(row.linkedOperationId !== undefined
      ? { linkedOperationId: requireRecoveryText(row.linkedOperationId, "invalid_operation", "linkedOperationId") }
      : {}),
    createdAt: requireRecoveryNumber(row.createdAt, "invalid_observed_at", "createdAt"),
    updatedAt: requireRecoveryNumber(row.updatedAt, "invalid_observed_at", "updatedAt"),
  }
}

export function parseRecoveryRefusal(input: unknown): RecoveryRefusal {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_refusal", "recovery refusal must be an object")
  const message = requireRecoveryText(row.message, "invalid_refusal", "message")
  switch (row.kind) {
    case "generation_conflict":
      return {
        kind: "generation_conflict",
        message,
        ...(row.current !== undefined ? { current: parseRecoveryTarget(row.current) } : {}),
      }
    case "intent_conflict":
    case "receipt_expired":
      return { kind: row.kind, message, requestId: requireRecoveryText(row.requestId, "invalid_request_id", "requestId") }
    case "scope_changed":
      return {
        kind: "scope_changed",
        message,
        scopeRevision: requireRecoveryText(row.scopeRevision, "invalid_scope_revision", "scopeRevision"),
        preview: parseScopePreview(row.preview),
      }
    case "unauthorized":
    case "unavailable":
      return { kind: row.kind, message }
    case "version_update_required":
      return {
        kind: "version_update_required",
        message,
        contractVersion: requireRecoveryNumber(row.contractVersion, "invalid_refusal", "contractVersion"),
      }
    default:
      throw new RecoveryContractError("invalid_refusal", `unknown recovery refusal ${JSON.stringify(row.kind)}`)
  }
}

export function serializeRecoveryOutcome(outcome: RecoveryOutcome): string {
  return JSON.stringify(outcome)
}

/** Accepts the HTTP body as text or an already decoded IPC value. */
export function parseRecoveryOutcome(input: unknown): RecoveryOutcome {
  if (typeof input !== "string") return decodeOutcome(input)
  try {
    return decodeOutcome(JSON.parse(input))
  } catch (error) {
    if (error instanceof RecoveryContractError) throw error
    throw new RecoveryContractError("invalid_payload", "recovery outcome is not valid JSON")
  }
}

export function isRecoveryOutcome(value: unknown): value is RecoveryOutcome {
  try {
    decodeOutcome(value)
    return true
  } catch (error) {
    if (error instanceof RecoveryContractError) return false
    throw error
  }
}

function decodeOutcome(value: unknown): RecoveryOutcome {
  const row = asRecord(value)
  if (!row) throw new RecoveryContractError("invalid_payload", "recovery outcome must be an object")
  if (row.kind === "operation") return { kind: "operation", operation: parseRecoveryOperation(row.operation) }
  if (row.kind === "refused") return { kind: "refused", refusal: parseRecoveryRefusal(row.refusal) }
  throw new RecoveryContractError("invalid_payload", `unknown recovery outcome ${JSON.stringify(row.kind)}`)
}

function parseScopePreview(input: unknown): RecoveryScopePreview {
  const row = asRecord(input)
  if (!row || !Array.isArray(row.sessions) || !Array.isArray(row.resources)) {
    throw new RecoveryContractError("invalid_refusal", "recovery scope preview requires sessions and resources")
  }
  return {
    sessions: row.sessions.map((value) => requireRecoveryText(value, "invalid_refusal", "session")),
    resources: row.resources.map((value) => requireRecoveryText(value, "invalid_refusal", "resource")),
    summary: requireRecoveryText(row.summary, "invalid_refusal", "summary"),
  }
}

/** The one place an action is checked against the owner its target names. */
function scopedTarget(action: RecoveryAction, input: unknown): RecoveryTarget {
  const target = parseRecoveryTarget(input)
  if (!RECOVERY_ACTION_SCOPES[action].includes(target.scope)) {
    throw new RecoveryContractError("scope_mismatch", `recovery action ${action} cannot target a ${target.scope}`)
  }
  return target
}

function parseNextAction(input: unknown): RecoveryNextAction {
  const row = asRecord(input)
  if (!row) throw new RecoveryContractError("invalid_operation", "recovery next action must be an object")
  if (!member(RECOVERY_ACTIONS, row.action)) {
    throw new RecoveryContractError("invalid_action", `unknown recovery action ${JSON.stringify(row.action)}`)
  }
  if (typeof row.scopePreviewRequired !== "boolean") {
    throw new RecoveryContractError("invalid_operation", "recovery next action scopePreviewRequired is required")
  }
  return {
    action: row.action,
    scopePreviewRequired: row.scopePreviewRequired,
    reason: requireRecoveryText(row.reason, "invalid_operation", "reason"),
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

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

function requireRecoveryText(value: unknown, code: RecoveryContractErrorCode, label: string): string {
  const found = asText(value)
  if (found === undefined) throw new RecoveryContractError(code, `recovery ${label} must be a non-empty string`)
  return found
}

function requireRecoveryNumber(value: unknown, code: RecoveryContractErrorCode, label: string): number {
  const found = asFiniteNumber(value)
  if (found === undefined) throw new RecoveryContractError(code, `recovery ${label} must be a finite number`)
  return found
}
