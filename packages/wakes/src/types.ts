// Core types for the wakes layer.
//
// A `wake` is a durable record: resume session S when trigger T fires, injecting
// a result into the new turn. One shape, three trigger types.

export type SessionId = string
export type WorkspaceId = string
export type WakeId = string
export type Token = string
export type Json = unknown

/** An actor that creates or resolves wakes. Opaque beyond `userId`. */
export interface Actor {
  userId: string
  [k: string]: unknown
}

export type TriggerType = "at" | "on_event" | "on_approval"

/** Lifecycle. `pending` is the only state a fire/expire/cancel can exit from. */
export type WakeState = "pending" | "firing" | "fired" | "expired" | "cancelled"

/** The payload injected into the resumed turn. */
export type WakeResult =
  | { trigger: "at"; intent: Json }
  | { trigger: "at"; intent: Json; expired: true }
  | { trigger: "on_event"; intent: Json; payload: Json }
  | { trigger: "on_approval"; answer: string; resolvedBy: Actor }

/**
 * What firing a wake does. `session_turn` (the default) resumes a session;
 * hosts register other kinds via the `sinks` option.
 */
export type WakeKind = string

/** A durable wake row. `null` timestamps/params are absent-by-type. */
export interface Wake {
  id: WakeId
  sessionId: SessionId | null
  workspaceId: WorkspaceId
  triggerType: TriggerType
  /** Selects the sink that runs when this wake fires. Default "session_turn". */
  kind: WakeKind
  /**
   * Serialization lane for time-triggered fires: while one wake of a key is
   * `firing`, no other wake of that key can be claimed. Wakes of different
   * keys (and null-key wakes) fire in parallel. Null = no lane.
   */
  serialKey: string | null
  intentJson: string
  /** Set at pending→firing for on_event/on_approval so a crash can re-drive it. */
  resultJson: string | null
  state: WakeState
  expiresAt: number | null
  depth: number
  createdBy: string | null
  createdAt: number
  firedAt: number | null
  // trigger params (one set, by type)
  fireAt: number | null
  schedule: string | null
  eventKey: string | null
  token: string | null
  prompt: string | null
  resolvedBy: string | null
  idempotencyKey: string | null
  // time-trigger claim lease
  leaseUntil: number | null
  attempts: number
}

export type ResolveOutcome =
  | { ok: true }
  | { ok: false; reason: "too_late" | "already_resolved" | "unauthorized" | "not_found" }

/** Resume (or start, when sessionId is null) a turn against a session. At-least-once. */
export type SpawnTurn = (sessionId: SessionId | null, result: WakeResult) => Promise<void>

/**
 * A firing handler for one wake kind. Receives the whole wake plus the
 * reconstructed result. Runs at-least-once: a throw leaves the row in
 * `firing` for lease-reclaim to re-drive.
 */
export type WakeSink = (wake: Wake, result: WakeResult) => Promise<void> | void

/** Host authz: may this actor resolve an approval for this workspace? */
export type Authorize = (actor: Actor, workspaceId: WorkspaceId) => Promise<boolean> | boolean

/** Per-workspace limits on agent-authored wakes. */
export interface Budgets {
  /** Max concurrent pending wakes per workspace. Default 1000. */
  maxLiveWakes?: number
  /** Max wakes created per rolling hour per workspace. Default 240. */
  creationRatePerHour?: number
  /** Reject fireAt beyond now + this. Default 90 days. */
  maxHorizonMs?: number
  /** Max self-schedule depth (recursion bound). Default 5. */
  maxDepth?: number
}

/** Compute the next fire time for a cron expression, strictly after `afterMs`. */
export type ComputeNextRun = (cron: string, afterMs: number) => number
