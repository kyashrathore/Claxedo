import {
  composeHostedControlPlane,
  HostedWorkerCompositionError,
  type HostedWorkerEnv,
} from "../../control-plane/hosted-services"
import { reportError } from "../../observability/report"
import { createHostedWorkGraphRuntime } from "../../workgraph-host/hosted-runtime"
import {
  settlementTenantKey,
  type SettlementDispatcher,
  type SettlementTenant,
} from "../../workgraph-host/settlement-dispatcher"

const MAX_BACKOFF_MS = 30_000
const MIN_BACKOFF_MS = 1_000
const SETTLEMENT_WINDOW_MS = 10 * 60_000
const ACTIVITY_GRACE_MS = 30_000
const TENANT_KEY = "tenant"
const STARTED_AT_KEY = "settlementStartedAt"
const BACKOFF_KEY = "settlementBackoffMs"
const RETRY_UNTIL_KEY = "settlementRetryUntil"
const PROGRESS_KEYS = [STARTED_AT_KEY, BACKOFF_KEY, RETRY_UNTIL_KEY]

export interface WorkGraphSettlerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(keys: string | string[]): Promise<unknown>
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}

export type WorkGraphSettlerState = Readonly<{ storage: WorkGraphSettlerStorage }>

export interface WorkGraphSettlerStub {
  fetch(request: Request): Promise<Response>
}

export interface WorkGraphSettlerNamespace {
  idFromName(name: string): unknown
  get(id: unknown): WorkGraphSettlerStub
}

export async function dispatchCloudflareSettlement(
  namespace: WorkGraphSettlerNamespace,
  tenant: SettlementTenant,
) {
  const response = await namespace
    .get(namespace.idFromName(settlementTenantKey(tenant)))
    .fetch(
      new Request("https://workgraph-settler.internal/nudge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tenant),
      }),
    )
  if (!response.ok) {
    throw new Error(`WorkGraph settler nudge failed: ${response.status} ${await response.text()}`.trim())
  }
}

type SettlerOptions = Readonly<{
  now?: () => number
  settle?: (tenant: SettlementTenant) => Promise<unknown>
}>

type RearmHint = Readonly<{
  pending: boolean
  retryAfterMs?: number
  keepAliveMs?: number
}>

export function createCloudflareSettlementDispatcher(input: Readonly<{
  namespace: WorkGraphSettlerNamespace
  waitUntil: (promise: Promise<unknown>) => void
  reportError?: typeof reportError
}>): SettlementDispatcher {
  const errorReporter = input.reportError ?? reportError
  const report = (error: unknown) => {
    try {
      errorReporter(error, { tags: { source: "workgraph_cloudflare_settlement_dispatcher" } })
    } catch {
      // A nudge and its reporting are advisory. Neither may affect the command response.
    }
  }
  return {
    nudge(tenant) {
      try {
        input.waitUntil(
          dispatchCloudflareSettlement(input.namespace, tenant).catch(report),
        )
      } catch (error) {
        report(error)
      }
    },
  }
}

/**
 * Per-tenant Worker fast lane. Durable state contains only timer bookkeeping
 * and the tenant routing identity; Convex remains the settlement truth.
 */
export class WorkGraphSettler {
  private tenantLoading?: Promise<SettlementTenant>
  private nudgeScheduled?: Promise<void>
  private settleRuntime?: (tenant: SettlementTenant) => Promise<unknown>
  private readonly now: () => number

  constructor(
    private readonly state: WorkGraphSettlerState,
    private readonly env: Record<string, unknown>,
    private readonly options: SettlerOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/nudge") {
      return new Response("Not Found", { status: 404 })
    }
    const body = await request.json().catch(() => undefined)
    const tenant = requireTenant(body)
    await this.loadTenant(tenant)
    if (!this.nudgeScheduled) {
      const scheduled = this.scheduleNudge().finally(() => {
        if (this.nudgeScheduled === scheduled) this.nudgeScheduled = undefined
      })
      this.nudgeScheduled = scheduled
    }
    await this.nudgeScheduled
    return new Response(null, { status: 204 })
  }

  async alarm() {
    const tenant = await this.loadTenant()
    const invokedAt = this.now()
    const [persistedStartedAt, storedRetryUntil, storedBackoff] = await Promise.all([
      this.state.storage.get<number>(STARTED_AT_KEY),
      this.state.storage.get<number>(RETRY_UNTIL_KEY),
      this.state.storage.get<number>(BACKOFF_KEY),
    ])
    const startedAt = persistedStartedAt ?? invokedAt
    if (persistedStartedAt === undefined) await this.state.storage.put(STARTED_AT_KEY, startedAt)
    const result = await this.settle(tenant)
    const completedAt = this.now()
    const hint = settlementRearmHint(result)
    const priorRetryUntil = storedRetryUntil ?? 0
    const retryUntil = Math.max(
      priorRetryUntil,
      hint.retryAfterMs === undefined ? 0 : completedAt + hint.retryAfterMs,
      hint.keepAliveMs === undefined ? 0 : completedAt + hint.keepAliveMs,
    )
    if ((!hint.pending && retryUntil <= completedAt) || completedAt - startedAt >= SETTLEMENT_WINDOW_MS) {
      await this.state.storage.delete(PROGRESS_KEYS)
      return
    }
    const priorBackoff = storedBackoff ?? 0
    const delay = Math.min(
      MAX_BACKOFF_MS,
      Math.max(MIN_BACKOFF_MS, hint.retryAfterMs ?? 0, priorBackoff ? priorBackoff * 2 : 0),
    )
    await Promise.all([
      this.state.storage.put(BACKOFF_KEY, delay),
      this.state.storage.put(RETRY_UNTIL_KEY, retryUntil),
    ])
    await this.setEarlierAlarm(completedAt + delay)
  }

  private async scheduleNudge() {
    await this.setEarlierAlarm(this.now())
  }

  private async setEarlierAlarm(scheduledTime: number) {
    const alarm = await this.state.storage.getAlarm()
    if (alarm !== null && alarm <= scheduledTime) return
    await this.state.storage.setAlarm(scheduledTime)
  }

  private loadTenant(candidate?: SettlementTenant) {
    if (!this.tenantLoading) {
      const loading = this.readTenant(candidate)
      this.tenantLoading = loading
      void loading.catch(() => {
        if (this.tenantLoading === loading) this.tenantLoading = undefined
      })
    }
    return this.tenantLoading.then((tenant) => {
      if (candidate && settlementTenantKey(candidate) !== settlementTenantKey(tenant)) {
        throw new Error("WorkGraph settler tenant does not match its persisted identity")
      }
      return tenant
    })
  }

  private async readTenant(candidate?: SettlementTenant) {
    const stored = await this.state.storage.get<SettlementTenant>(TENANT_KEY)
    if (stored) return requireTenant(stored)
    if (!candidate) throw new Error("WorkGraph settler has no persisted tenant identity")
    const tenant = requireTenant(candidate)
    await this.state.storage.put(TENANT_KEY, tenant)
    return tenant
  }

  private settle(tenant: SettlementTenant) {
    if (this.options.settle) return this.options.settle(tenant)
    this.settleRuntime ??= this.composeRuntime(tenant)
    return this.settleRuntime(tenant)
  }

  private composeRuntime(tenant: SettlementTenant) {
    const hostedEnv = {
      ...(this.env as HostedWorkerEnv),
      CLAXEDO_WORKGRAPH_WORKER_ID: `claxedo-settler:${settlementTenantKey(tenant)}`,
    }
    const runtime = createHostedWorkGraphRuntime(hostedEnv, composeHostedControlPlane(hostedEnv).services)
    if (!runtime) {
      throw new HostedWorkerCompositionError(
        "workgraph_settler_unavailable",
        "WorkGraph settler requires hosted Convex storage and a Control Plane service token",
      )
    }
    return (tenant: SettlementTenant) => runtime.reconcile({ tenants: [tenant], trigger: "nudge" })
  }
}

function requireTenant(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("WorkGraph settler requires a tenant identity")
  }
  const tenant = input as Record<string, unknown>
  if (typeof tenant.organizationId !== "string" || !tenant.organizationId.trim() || typeof tenant.ownerUserId !== "string" || !tenant.ownerUserId.trim()) {
    throw new Error("WorkGraph settler requires a non-empty organization and owner identity")
  }
  return { organizationId: tenant.organizationId, ownerUserId: tenant.ownerUserId }
}

function settlementRearmHint(input: unknown): RearmHint {
  const visited = new Set<object>()
  let pending = false
  let retryAfterMs: number | undefined
  let keepAliveMs: number | undefined
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Record<string, unknown>
    if (record.unsettled === true || record.settled === false || unsettledState(record.state)) pending = true
    if (finiteNonNegative(record.retryAfterMs)) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, record.retryAfterMs)
      pending = true
    }
    if (Array.isArray(record.launched) && record.launched.length > 0) {
      pending = true
      retryAfterMs ??= MIN_BACKOFF_MS
      keepAliveMs = ACTIVITY_GRACE_MS
    }
    Object.values(record).forEach(visit)
  }
  visit(input)
  return {
    pending,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
  }
}

function unsettledState(value: unknown) {
  return typeof value === "string" && ["pending", "provisioning", "running", "retrying_explicit_completion", "compensating"].includes(value)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
