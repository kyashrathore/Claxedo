import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"
import type {
  SandboxCheckpointReference,
  SandboxLeaseAcquireInput,
  SandboxLeaseAcquireResult,
  SandboxLeasePatch,
  SandboxLeaseStore,
  SandboxLease,
  SandboxPersistenceCapabilities,
  SandboxRestoreStatus,
} from "@claxedo/sandbox-manager"

type ConvexExecutor = {
  query: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
  mutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown>
}

type ConvexSandboxLease = {
  workspace_id: string
  home_region: string
  driver: string
  epoch: number
  status: SandboxLease["status"]
  retry_count: number
  created_at: number
  updated_at: number
  sandbox_id?: string
  url?: string
  host_id?: string
  driver_resource_id?: string
  next_retry_at?: number
  last_error?: string
  last_heartbeat_at?: number
  last_activity_at?: number
  labels?: Record<string, string>
  checkpoint?: SandboxCheckpointReference
  persistence_capabilities?: SandboxPersistenceCapabilities
  restore_status?: SandboxRestoreStatus
}

const convexLeaseFunctions = (anyApi as unknown as Record<string, {
  acquire: unknown
  update: unknown
  recordFailure: unknown
  release: unknown
  get: unknown
  list: unknown
}>).sandboxLeases

function executor(url: string): ConvexExecutor {
  const client = new ConvexHttpClient(url)
  return {
    query: (fn, args) => client.query(fn as never, args as never),
    mutation: (fn, args) => client.mutation(fn as never, args as never),
  }
}

function lease(row: ConvexSandboxLease): SandboxLease {
  return {
    workspaceId: row.workspace_id,
    homeRegion: row.home_region as SandboxLease["homeRegion"],
    driver: row.driver,
    epoch: row.epoch,
    status: row.status,
    retryCount: row.retry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sandboxId: row.sandbox_id,
    url: row.url,
    hostId: row.host_id,
    driverResourceId: row.driver_resource_id,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastActivityAt: row.last_activity_at,
    labels: row.labels,
    checkpoint: row.checkpoint,
    persistence: row.persistence_capabilities,
    restore: row.restore_status,
  }
}

function patch(input: SandboxLeasePatch) {
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.sandboxId === undefined ? {} : { sandbox_id: input.sandboxId }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.hostId === undefined ? {} : { host_id: input.hostId }),
    ...(input.driverResourceId === undefined ? {} : {
      driver_resource_id: input.driverResourceId,
    }),
    ...(input.retryCount === undefined ? {} : { retry_count: input.retryCount }),
    ...(input.lastHeartbeatAt === undefined ? {} : { last_heartbeat_at: input.lastHeartbeatAt }),
    ...(input.lastActivityAt === undefined ? {} : { last_activity_at: input.lastActivityAt }),
    ...(input.nextRetryAt === undefined ? {} : { next_retry_at: input.nextRetryAt }),
    ...(input.lastError === undefined ? {} : { last_error: input.lastError }),
    ...(input.labels === undefined ? {} : { labels: input.labels }),
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
    ...(input.persistence === undefined ? {} : { persistence_capabilities: input.persistence }),
    ...(input.restore === undefined ? {} : { restore_status: input.restore }),
  }
}

export function createConvexLeaseStore(input: { url?: string; token?: string; executor?: ConvexExecutor }): SandboxLeaseStore {
  const exec = input.executor ?? executor(input.url!)
  // Convex sandbox lease functions are service-only: every call carries the
  // Control Plane service token and Convex rejects calls when it is missing
  // or mismatched (fail closed).
  const serviceToken = input.token ?? ""
  return {
    async acquire(workspaceId: string, acquireInput: SandboxLeaseAcquireInput): Promise<SandboxLeaseAcquireResult> {
      const result = await exec.mutation(convexLeaseFunctions.acquire, {
        service_token: serviceToken,
        workspace_id: workspaceId,
        home_region: acquireInput.homeRegion,
        driver: acquireInput.driver,
        stale_after_ms: acquireInput.staleAfterMs,
        ...(acquireInput.now === undefined ? {} : { now: acquireInput.now }),
      }) as { acquired: true; lease: ConvexSandboxLease } | { acquired: false; lease: ConvexSandboxLease; retry_after_ms: number }
      if (result.acquired) return { acquired: true, lease: lease(result.lease) }
      return { acquired: false, lease: lease(result.lease), retryAfterMs: result.retry_after_ms }
    },
    async update(workspaceId: string, expectedEpoch: number, inputPatch: SandboxLeasePatch) {
      const result = await exec.mutation(convexLeaseFunctions.update, {
        service_token: serviceToken,
        workspace_id: workspaceId,
        expected_epoch: expectedEpoch,
        patch: patch(inputPatch),
      }) as ConvexSandboxLease | null
      return result ? lease(result) : undefined
    },
    async recordFailure(workspaceId: string, expectedEpoch: number, error: string, nextRetryAt?: number) {
      const result = await exec.mutation(convexLeaseFunctions.recordFailure, {
        service_token: serviceToken,
        workspace_id: workspaceId,
        expected_epoch: expectedEpoch,
        error,
        ...(nextRetryAt === undefined ? {} : { next_retry_at: nextRetryAt }),
      }) as ConvexSandboxLease | null
      return result ? lease(result) : undefined
    },
    async release(workspaceId: string) {
      await exec.mutation(convexLeaseFunctions.release, { service_token: serviceToken, workspace_id: workspaceId })
    },
    async get(workspaceId: string) {
      const result = await exec.query(convexLeaseFunctions.get, {
        service_token: serviceToken,
        workspace_id: workspaceId,
      }) as ConvexSandboxLease | null
      return result ? lease(result) : undefined
    },
    async list() {
      const result = await exec.query(convexLeaseFunctions.list, { service_token: serviceToken }) as ConvexSandboxLease[]
      return result.map(lease)
    },
  }
}
