// Hosted wakes composition for the Cloudflare Worker: the Convex-backed
// engine plus the registered sinks.
// Used inside the WakeLane Durable Object alarm; Worker-safe by construction
// (no sqlite, no node-only imports).
//
// Sinks registered here:
// - `workgraph_settle`: the wake is a per-tenant dirty flag
//   (serialKey/intent = tenant). Firing runs the tenant-scoped WorkGraph
//   reconcile. If the reconcile reports unsettled work (sandbox provisioning,
//   launches in flight), the sink schedules a durable RETRY WAKE on the same
//   lane — the retry survives isolate death because it is a row, not a timer.
// - `workgraph_master`: one serialized turn for a Stream's durable master.

import { createWakes, type WakeDriver, type Wakes, type WakeStore } from "@claxedo/wakes"
import {
  MASTER_DAILY_SCHEDULE,
  nextDailyMasterRun as nextDailyMasterRunAt,
  workGraphMasterLaneKey,
  workGraphMasterLaneWorkspace,
} from "@claxedo/workgraph/contracts"
import { clean } from "../control-plane/adapters/worker/hosted-compose"
import {
  composeHostedControlPlane,
  HostedWorkerCompositionError,
  type HostedWorkerEnv,
} from "../control-plane/hosted-services"
import { createHostedWorkGraphRuntime } from "../workgraph-host/hosted-runtime"
import { settlementTenantKey, type SettlementTenant } from "../workgraph-host/settlement-dispatcher"
import { ConvexWakeStore } from "./convex-wake-store"

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

export const WORKGRAPH_SETTLE_KIND = "workgraph_settle"
export const WORKGRAPH_MASTER_KIND = "workgraph_master"
// Control effects (Stream delete/close, Attempt interrupt) drain on a lane
// distinct from `workgraph_settle` so they never queue behind a tenant's
// launch-provision / running-history reconcile pass (measured settle-wake
// lateness p90 22.8s / p95 32.2s on staging). Same ClaxedoWakeLane DO class,
// just a `${tenant}:control` serialKey → its own idle DO instance; no wrangler
// migration. The settle lane + 15-min sweep still backstop the outbox truth.
export const WORKGRAPH_CONTROL_KIND = "workgraph_control"

export type WorkGraphMasterIntent = SettlementTenant & Readonly<{
  streamId: string
  trigger: "mailbox" | "task_settled" | "schedule"
}>

export function workGraphMasterKey(intent: Pick<WorkGraphMasterIntent, "organizationId" | "ownerUserId" | "streamId">) {
  return workGraphMasterLaneKey(intent)
}

export function workGraphMasterWake(intent: WorkGraphMasterIntent, now: number) {
  return {
    kind: WORKGRAPH_MASTER_KIND,
    serialKey: workGraphMasterLaneKey(intent),
    workspaceId: workGraphMasterLaneWorkspace(intent),
    at: now,
    intent,
  }
}

/**
 * The dirty-flag wake for one tenant. Deliberately NO engine idempotencyKey:
 * those dedup forever (a fired wake would swallow every later command).
 * Burst coalescing is state-aware instead — the Convex in-transaction creator
 * skips the insert when a PENDING settle wake already holds the lane.
 */
export function workGraphSettleWake(tenant: SettlementTenant, now: number) {
  const key = settlementTenantKey(tenant)
  return {
    kind: WORKGRAPH_SETTLE_KIND,
    serialKey: key,
    workspaceId: `wg:${key}`,
    at: now,
    intent: tenant,
  }
}

/** The control-drain dirty flag for one tenant, on its own dedicated lane. */
export function workGraphControlWake(tenant: SettlementTenant, now: number) {
  const key = settlementTenantKey(tenant)
  return {
    kind: WORKGRAPH_CONTROL_KIND,
    serialKey: `${key}:control`,
    workspaceId: `wg:${key}:control`,
    at: now,
    intent: tenant,
  }
}

export function parseSettleTenant(intentJson: string): SettlementTenant {
  const intent = JSON.parse(intentJson) as Partial<SettlementTenant> | null
  if (!intent || typeof intent.organizationId !== "string" || typeof intent.ownerUserId !== "string") {
    throw new Error("workgraph_settle wake carries no tenant identity")
  }
  return { organizationId: intent.organizationId, ownerUserId: intent.ownerUserId }
}

export function parseMasterIntent(intentJson: string): WorkGraphMasterIntent {
  const intent = JSON.parse(intentJson) as Partial<WorkGraphMasterIntent> | null
  if (
    !intent || typeof intent.organizationId !== "string" || typeof intent.ownerUserId !== "string" ||
    typeof intent.streamId !== "string" ||
    (intent.trigger !== "mailbox" && intent.trigger !== "task_settled" && intent.trigger !== "schedule")
  ) throw new Error("workgraph_master wake carries no Stream identity")
  return {
    organizationId: intent.organizationId,
    ownerUserId: intent.ownerUserId,
    streamId: intent.streamId,
    trigger: intent.trigger,
  }
}

type ComposeOptions = Readonly<{
  now?: () => number
  /** Injectable settle for tests; defaults to the tenant-scoped hosted reconcile. */
  settle?: (tenant: SettlementTenant) => Promise<unknown>
  /** Injectable control drain for tests; defaults to a `controlOnly` reconcile. */
  control?: (tenant: SettlementTenant) => Promise<unknown>
  master?: (intent: WorkGraphMasterIntent) => Promise<unknown>
  store?: WakeStore
}>

/**
 * Build the Worker-side wakes engine. System instance: budgets are effectively
 * disabled (settle wakes are infra bookkeeping, not agent-authored), and there
 * is no session sink — agent-facing wakes stay on the Node server.
 */
export function composeHostedWakes(
  env: HostedWorkerEnv,
  driver: WakeDriver,
  options: ComposeOptions = {},
): Wakes {
  const now = options.now ?? Date.now
  const url = clean(env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  const serviceToken = clean(env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  if (!options.store && (!url || !serviceToken)) {
    throw new HostedWorkerCompositionError(
      "wakes_unavailable",
      "Hosted wakes require Convex storage and a Control Plane service token",
    )
  }
  const store = options.store ?? new ConvexWakeStore({ url: url!, serviceToken: serviceToken!, now })
  let settleRuntime: ((tenant: SettlementTenant) => Promise<unknown>) | undefined
  let controlRuntime: ((tenant: SettlementTenant) => Promise<unknown>) | undefined
  let masterRuntime: ((intent: WorkGraphMasterIntent) => Promise<unknown>) | undefined
  const settle = (tenant: SettlementTenant) => {
    if (options.settle) return options.settle(tenant)
    if (!settleRuntime) {
      const hostedEnv = { ...env, CLAXEDO_WORKGRAPH_WORKER_ID: `claxedo-wake-lane:${settlementTenantKey(tenant)}` }
      const runtime = createHostedWorkGraphRuntime(hostedEnv, composeHostedControlPlane(hostedEnv).services)
      if (!runtime) {
        throw new HostedWorkerCompositionError(
          "wakes_settle_unavailable",
          "workgraph_settle requires hosted Convex storage and a Control Plane service token",
        )
      }
      settleRuntime = (target) => runtime.reconcile({ tenants: [target], trigger: "nudge" })
    }
    return settleRuntime(tenant)
  }
  // Control-only reconcile: same runtime, but `controlOnly` skips launch
  // provisioning / running-history polling so the drain stays ~1-2s.
  const control = (tenant: SettlementTenant) => {
    if (options.control) return options.control(tenant)
    if (!controlRuntime) {
      const hostedEnv = { ...env, CLAXEDO_WORKGRAPH_WORKER_ID: `claxedo-control-lane:${settlementTenantKey(tenant)}` }
      const runtime = createHostedWorkGraphRuntime(hostedEnv, composeHostedControlPlane(hostedEnv).services)
      if (!runtime) {
        throw new HostedWorkerCompositionError(
          "wakes_settle_unavailable",
          "workgraph_control requires hosted Convex storage and a Control Plane service token",
        )
      }
      controlRuntime = (target) => runtime.reconcile({ tenants: [target], trigger: "nudge", controlOnly: true })
    }
    return controlRuntime(tenant)
  }
  const master = (intent: WorkGraphMasterIntent) => {
    if (options.master) return options.master(intent)
    if (!masterRuntime) {
      const hostedEnv = { ...env, CLAXEDO_WORKGRAPH_WORKER_ID: `claxedo-master-lane:${workGraphMasterKey(intent)}` }
      const runtime = createHostedWorkGraphRuntime(hostedEnv, composeHostedControlPlane(hostedEnv).services)
      if (!runtime) {
        throw new HostedWorkerCompositionError(
          "wakes_master_unavailable",
          "workgraph_master requires hosted Convex storage and a Control Plane service token",
        )
      }
      masterRuntime = runtime.master
    }
    return masterRuntime(intent)
  }
  // Late-bound so the sink can schedule retry wakes through the same engine.
  let wakes: Wakes
  wakes = createWakes({
    store,
    driver,
    now,
    computeNextRun: nextDailyMasterRun,
    budgets: {
      maxLiveWakes: Number.MAX_SAFE_INTEGER,
      creationRatePerHour: Number.MAX_SAFE_INTEGER,
      maxDepth: Number.MAX_SAFE_INTEGER,
    },
    sinks: {
      [WORKGRAPH_SETTLE_KIND]: async (wake) => {
        const tenant = parseSettleTenant(wake.intentJson)
        const result = await settle(tenant)
        const delay = settleRetryDelayMs(result)
        if (delay !== undefined) {
          const fireAt = now() + delay
          await wakes.schedule({
            workspaceId: wake.workspaceId,
            kind: WORKGRAPH_SETTLE_KIND,
            serialKey: wake.serialKey ?? undefined,
            at: fireAt,
            intent: tenant,
            // per-target-time key: bursts coalesce, distinct retries don't
            idempotencyKey: `settle:${settlementTenantKey(tenant)}:${fireAt}`,
          })
        }
      },
      [WORKGRAPH_CONTROL_KIND]: async (wake) => {
        const tenant = parseSettleTenant(wake.intentJson)
        const result = await control(tenant)
        const delay = settleRetryDelayMs(result)
        if (delay !== undefined) {
          const fireAt = now() + delay
          await wakes.schedule({
            workspaceId: wake.workspaceId,
            kind: WORKGRAPH_CONTROL_KIND,
            serialKey: wake.serialKey ?? undefined,
            at: fireAt,
            intent: tenant,
            idempotencyKey: `control:${settlementTenantKey(tenant)}:${fireAt}`,
          })
        }
      },
      [WORKGRAPH_MASTER_KIND]: async (wake) => {
        const intent = parseMasterIntent(wake.intentJson)
        const result = await master(intent)
        const delay = settleRetryDelayMs(result)
        if (delay !== undefined) {
          const fireAt = now() + delay
          await wakes.schedule({
            workspaceId: wake.workspaceId,
            kind: WORKGRAPH_MASTER_KIND,
            serialKey: wake.serialKey ?? undefined,
            at: fireAt,
            intent,
            idempotencyKey: `master:${workGraphMasterKey(intent)}:${fireAt}`,
          })
        }
      },
    },
  })
  return wakes
}

export function nextDailyMasterRun(schedule: string, afterMs: number) {
  if (schedule !== MASTER_DAILY_SCHEDULE) throw new Error(`Unsupported hosted wake schedule: ${schedule}`)
  return nextDailyMasterRunAt(afterMs)
}

/**
 * Decide whether the reconcile left unsettled work behind, mirroring the
 * WorkGraphSettler rearm heuristic: unsettled/pending markers or an explicit
 * retryAfterMs anywhere in the result ask for a durable retry.
 */
export function settleRetryDelayMs(result: unknown): number | undefined {
  const visited = new Set<object>()
  let pending = false
  let retryAfterMs: number | undefined
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Record<string, unknown>
    if (record.unsettled === true || record.settled === false || unsettledState(record.state)) pending = true
    if (typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, record.retryAfterMs)
      pending = true
    }
    if (Array.isArray(record.launched) && record.launched.length > 0) pending = true
    Object.values(record).forEach(visit)
  }
  visit(result)
  if (!pending) return undefined
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryAfterMs ?? RETRY_MIN_MS))
}

function unsettledState(value: unknown) {
  return (
    typeof value === "string" &&
    ["pending", "provisioning", "running", "retrying_explicit_completion", "compensating"].includes(value)
  )
}
