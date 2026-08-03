/**
 * W5 metering events — sandbox compute, AI tokens, activation.
 *
 * These are the two cost questions ("how much sandbox compute does my average
 * user consume?", "how many AI tokens?") plus the activation moment that makes
 * both attributable. All of it is product plane: `captureProduct` enforces
 * `{org_id, user_id, surface, deployment_mode}` at the type level and stamps
 * `$groups.org`, because an average-per-user is uncomputable in principle if a
 * single call site is allowed to omit the tenant.
 *
 * **Property shapes here are normative** (metric spec §4.2, §4.3, §4.5). The
 * builders are pure and exported so a test can assert the emitted fields
 * against a provider's usage object directly, rather than asserting that an
 * emit function was called.
 *
 * **Identity fallback.** Where a real emission point genuinely has no signed
 * tenant — the internal admin GC/release routes carry an operator bearer token
 * and no user, and the relay resolves targets with no session identity — the
 * event still goes out, through the raw ops-plane sink under `distinct_id:
 * "system"` and WITHOUT org/user properties. A fabricated tenant is strictly
 * worse than a missing one: it silently corrupts every per-org aggregate, and
 * the aggregate is the entire deliverable. `system_reason` names which
 * identity was absent so the gap is greppable from the data itself.
 */

import { captureProduct, type ProductCaptureSink, type ProductIdentity } from "./product"

export const SANDBOX_LEASE_OPENED = "sandbox.lease_opened"
export const SANDBOX_LEASE_CLOSED = "sandbox.lease_closed"
export const LLM_TURN_COMPLETED = "llm_turn_completed"
export const SESSION_STARTED = "session_started"
export const USER_ACTIVATED = "user_activated"

export type SandboxCloseReason = "idle_timeout" | "explicit_release" | "gc"

export type TurnStatus = "ok" | "error"

const workGraphAttribution = new Map<
  string,
  Readonly<{ streamId?: string; runId?: string; workItemId?: string }>
>()

export function registerWorkGraphSessionAttribution(
  sessionId: string,
  attribution: Readonly<{ streamId?: string; runId?: string; workItemId?: string }>,
) {
  workGraphAttribution.set(sessionId, attribution)
}

export function unregisterWorkGraphSessionAttribution(sessionId: string) {
  workGraphAttribution.delete(sessionId)
}

export function workGraphSessionAttribution(sessionId: string) {
  return workGraphAttribution.get(sessionId)
}

/** The token block `compat-events.ts` populates on a completed assistant message. */
export type CompatTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type LlmTurnRecord = {
  message_id: string
  session_id: string
  stream_id?: string
  run_id?: string
  work_item_id?: string
  harness: string
  provider_id: string
  model_id: string
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  turn_status: TurnStatus
  latency_ms: number
}

/**
 * The authoritative write. PostHog capture is best-effort by design, so
 * the number a paid plan may later be gated on lands in Convex as well.
 * `activated` reports the idempotent first-ok-turn check-and-set, which is what
 * lets `user_activated` fire exactly once per user for all time.
 */
export type UsageLedger = {
  resolveWorkGraphAttribution?: (input: {
    org_id: string
    user_id: string
    session_id: string
  }) => Promise<Readonly<{ stream_id?: string; run_id?: string; work_item_id?: string }> | undefined>
  recordLlmTurn: (
    input: LlmTurnRecord & { org_id: string; user_id: string },
  ) => Promise<{ activated: boolean }>
}

/** Raw ops-plane sink, for the emission points that hold no signed tenant. */
export type SystemCaptureSink = ProductCaptureSink

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** Normalize the compat token block into the flat, non-negative event shape. */
export function tokenProperties(tokens: CompatTokens | undefined) {
  return {
    input_tokens: count(tokens?.input),
    output_tokens: count(tokens?.output),
    reasoning_tokens: count(tokens?.reasoning),
    cache_read_tokens: count(tokens?.cache?.read),
    cache_write_tokens: count(tokens?.cache?.write),
  }
}

/**
 * Build the turn record from a completed assistant message.
 *
 * Returns `undefined` for anything that is not a finished assistant turn —
 * `message.updated` fires for user messages and for in-flight assistant
 * messages too, and metering a turn before it completes reports tokens that
 * have not been spent.
 */
export function llmTurnRecord(input: {
  message: unknown
  harness: string
  attribution?: Readonly<{ streamId?: string; runId?: string; workItemId?: string }>
}): LlmTurnRecord | undefined {
  const info = input.message as {
    role?: unknown
    id?: unknown
    sessionID?: unknown
    providerID?: unknown
    modelID?: unknown
    tokens?: CompatTokens
    error?: unknown
    time?: { created?: unknown; completed?: unknown }
  } | null
  if (!info || info.role !== "assistant") return undefined
  const messageId = typeof info.id === "string" ? info.id : undefined
  if (!messageId) return undefined
  const completed = info.time?.completed
  if (typeof completed !== "number") return undefined
  const sessionId = typeof info.sessionID === "string" ? info.sessionID : undefined
  if (!sessionId) return undefined
  const created = typeof info.time?.created === "number" ? info.time.created : completed
  return {
    message_id: messageId,
    session_id: sessionId,
    ...(input.attribution?.streamId ? { stream_id: input.attribution.streamId } : {}),
    ...(input.attribution?.runId ? { run_id: input.attribution.runId } : {}),
    ...(input.attribution?.workItemId ? { work_item_id: input.attribution.workItemId } : {}),
    harness: input.harness,
    provider_id: typeof info.providerID === "string" ? info.providerID : "unknown",
    model_id: typeof info.modelID === "string" ? info.modelID : "unknown",
    ...tokenProperties(info.tokens),
    turn_status: info.error ? "error" : "ok",
    latency_ms: Math.max(0, completed - created),
  }
}

export type SandboxLeaseOpened = {
  workspace_id: string
  sandbox_id?: string
  driver: string
  started_at: number
}

export type SandboxLeaseClosed = {
  workspace_id: string
  sandbox_id?: string
  driver: string
  started_at?: number
  ended_at: number
  /** Preferred when the ledger already subtracted it from one clock. */
  active_ms?: number
  reason: SandboxCloseReason
}

export function leaseOpenedProperties(input: SandboxLeaseOpened) {
  return {
    workspace_id: input.workspace_id,
    ...(input.sandbox_id ? { sandbox_id: input.sandbox_id } : {}),
    driver: input.driver,
    started_at: input.started_at,
  }
}

/**
 * `active_ms` comes from the ledger when it has it, because that value was
 * subtracted inside the transaction that closed the interval and cannot drift.
 * The local subtraction is the fallback for close paths that never opened a
 * metered interval; with neither, the duration is omitted rather than guessed
 * at as zero — a zero would average into the per-user answer as real data.
 */
export function leaseClosedProperties(input: SandboxLeaseClosed) {
  const activeMs = input.active_ms
    ?? (input.started_at === undefined ? undefined : Math.max(0, input.ended_at - input.started_at))
  return {
    workspace_id: input.workspace_id,
    ...(input.sandbox_id ? { sandbox_id: input.sandbox_id } : {}),
    driver: input.driver,
    ...(input.started_at === undefined ? {} : { started_at: input.started_at }),
    ended_at: input.ended_at,
    ...(activeMs === undefined ? {} : { active_ms: activeMs }),
    reason: input.reason,
  }
}

/**
 * Emit a metering event on whichever plane the call site can honestly reach:
 * product plane when a signed tenant is present, ops plane under `"system"`
 * when it is not.
 */
export function captureMetering(input: {
  identity: ProductIdentity | undefined
  sink: ProductCaptureSink | undefined
  event: string
  properties: Record<string, unknown>
  /** Names the absent identity when falling back to the ops plane. */
  systemReason: string
}) {
  if (input.identity) {
    captureProduct(input.sink, input.event, input.identity, input.properties)
    return
  }
  try {
    input.sink?.capture("system", input.event, {
      ...input.properties,
      system_reason: input.systemReason,
    })
  } catch {
    // Telemetry is evidence, never part of the operation it observes.
  }
}

export function emitSandboxLeaseOpened(input: {
  identity: ProductIdentity | undefined
  sink: ProductCaptureSink | undefined
  lease: SandboxLeaseOpened
  systemReason?: string
}) {
  captureMetering({
    identity: input.identity,
    sink: input.sink,
    event: SANDBOX_LEASE_OPENED,
    properties: leaseOpenedProperties(input.lease),
    systemReason: input.systemReason ?? "no_signed_tenant",
  })
}

export function emitSandboxLeaseClosed(input: {
  identity: ProductIdentity | undefined
  sink: ProductCaptureSink | undefined
  lease: SandboxLeaseClosed
  systemReason?: string
}) {
  captureMetering({
    identity: input.identity,
    sink: input.sink,
    event: SANDBOX_LEASE_CLOSED,
    properties: leaseClosedProperties(input.lease),
    systemReason: input.systemReason ?? "no_signed_tenant",
  })
}

/**
 * Dual-write one completed turn: the authoritative ledger row first, then the
 * PostHog view, then `user_activated` if the ledger reports this was the
 * user's first successful turn.
 *
 * The ledger decides activation because the check-and-set lives in the same
 * transaction as the fact that triggers it; a server-side "have we fired this
 * yet?" would race under concurrent turns and double-count the funnel's most
 * load-bearing step. A ledger failure still emits the analytics event — losing
 * the view as well as the record helps nobody — and reports the write as
 * degraded through `ledger_write: "failed"` so a silent gap is visible in the
 * data rather than only in logs.
 */
export async function emitLlmTurnCompleted(input: {
  identity: ProductIdentity | undefined
  sink: ProductCaptureSink | undefined
  ledger: UsageLedger | undefined
  record: LlmTurnRecord
}) {
  const identity = input.identity
  let activated = false
  let ledgerWrite: "ok" | "failed" | "skipped" = "skipped"
  if (identity && input.ledger) {
    try {
      const result = await input.ledger.recordLlmTurn({
        ...input.record,
        org_id: identity.org_id,
        user_id: identity.user_id,
      })
      activated = result.activated
      ledgerWrite = "ok"
    } catch {
      ledgerWrite = "failed"
    }
  }
  captureMetering({
    identity,
    sink: input.sink,
    event: LLM_TURN_COMPLETED,
    properties: { ...input.record, ledger_write: ledgerWrite },
    systemReason: "no_signed_tenant",
  })
  if (activated && identity) {
    captureProduct(input.sink, USER_ACTIVATED, identity, {
      session_id: input.record.session_id,
      harness: input.record.harness,
      provider_id: input.record.provider_id,
      model_id: input.record.model_id,
    })
  }
  return { activated, ledger_write: ledgerWrite }
}

export function emitSessionStarted(input: {
  identity: ProductIdentity | undefined
  sink: ProductCaptureSink | undefined
  session: { session_id: string; harness: string; workspace_id?: string; host: string }
}) {
  captureMetering({
    identity: input.identity,
    sink: input.sink,
    event: SESSION_STARTED,
    properties: {
      session_id: input.session.session_id,
      harness: input.session.harness,
      host: input.session.host,
      ...(input.session.workspace_id ? { workspace_id: input.session.workspace_id } : {}),
    },
    systemReason: "no_signed_tenant",
  })
}
