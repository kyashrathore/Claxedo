/**
 * Metering events — sandbox compute and session starts.
 *
 * All of it is product plane: `captureProduct` enforces
 * `{org_id, user_id, surface, deployment_mode}` at the type level and stamps
 * `$groups.org`, because an average-per-user is uncomputable in principle if a
 * single call site is allowed to omit the tenant.
 *
 * **Property shapes here are normative** (metric spec §4.2, §4.3). The
 * builders are pure and exported so a test can assert the emitted fields
 * directly, rather than asserting that an emit function was called.
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
import type {
  TurnUsageLocation,
  TurnUsageQuality,
  TurnUsageRevision,
  TurnUsageSettlement,
  TurnUsageStatus,
} from "@claxedo/server-core/usage/contracts"

export type {
  TurnUsageLocation,
  TurnUsageQuality,
  TurnUsageRevision,
  TurnUsageSettlement,
  TurnUsageStatus,
} from "@claxedo/server-core/usage/contracts"

export const SANDBOX_LEASE_OPENED = "sandbox.lease_opened"
export const SANDBOX_LEASE_CLOSED = "sandbox.lease_closed"
export const SESSION_STARTED = "session_started"

export type SandboxCloseReason = "idle_timeout" | "explicit_release" | "gc"

export type SandboxLeaseOpened = {
  workspace_id: string
  sandbox_id?: string
  driver: string
  /** `org` when the organization's own provider key made the machine. */
  key_owner?: "operator" | "org"
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
    ...(input.key_owner ? { key_owner: input.key_owner } : {}),
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
