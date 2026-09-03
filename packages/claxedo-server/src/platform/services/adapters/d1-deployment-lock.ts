import type { D1Database } from "@cloudflare/workers-types"

import type { ServiceDeploymentLock } from "../lifecycle-coordinator"

type Scope = Readonly<{ environmentId: string; deploymentId: string }>

type LockRow = Readonly<{
  operationId: string
  leaseToken: string
  fencingToken: number
  leaseExpiresAt: number
}>

export class ServiceDeploymentLockError extends Error {
  constructor(
    public readonly code: "invalid_identity" | "busy" | "lease_lost",
    message: string,
  ) {
    super(message)
    this.name = "ServiceDeploymentLockError"
  }
}

export type D1ServiceDeploymentLockOptions = Readonly<{
  leaseMs?: number
  heartbeatMs?: number
  now?: () => Date
  token?: () => string
}>

function required(value: string, field: string) {
  if (!value || value.trim() !== value) {
    throw new ServiceDeploymentLockError("invalid_identity", `${field} must be a non-empty trimmed string`)
  }
  return value
}

/**
 * A lease-backed, deployment-wide lock. The key deliberately excludes the
 * service id, so two optional services cannot race a core binding deploy.
 * The retained fencing token prevents an expired runner from releasing or
 * renewing the lock after a successor has acquired it.
 */
export class D1ServiceDeploymentLock implements ServiceDeploymentLock {
  private readonly leaseMs: number
  private readonly heartbeatMs: number
  private readonly now: () => Date
  private readonly token: () => string

  constructor(
    private readonly database: D1Database,
    options: D1ServiceDeploymentLockOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 60_000
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.now = options.now ?? (() => new Date())
    this.token = options.token ?? (() => crypto.randomUUID())
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new Error("service deployment lock leaseMs must be at least one second")
    }
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 1 || this.heartbeatMs >= this.leaseMs) {
      throw new Error("service deployment lock heartbeatMs must be positive and shorter than the lease")
    }
  }

  async withDeploymentLock<T>(rawScope: Scope, rawOperationId: string, work: () => Promise<T>): Promise<T> {
    const scope = {
      environmentId: required(rawScope.environmentId, "environmentId"),
      deploymentId: required(rawScope.deploymentId, "deploymentId"),
    }
    const operationId = required(rawOperationId, "operationId")
    const leaseToken = required(this.token(), "leaseToken")
    const acquired = await this.acquire(scope, operationId, leaseToken)
    let stopped = false
    let leaseFailure: unknown
    const heartbeat = setInterval(() => {
      void this.renew(scope, acquired).catch((error) => {
        leaseFailure = error
        clearInterval(heartbeat)
      })
    }, this.heartbeatMs)

    try {
      const result = await work()
      if (leaseFailure) throw leaseFailure
      await this.requireCurrent(scope, acquired)
      return result
    } finally {
      if (!stopped) {
        stopped = true
        clearInterval(heartbeat)
      }
      await this.release(scope, acquired)
    }
  }

  private async acquire(scope: Scope, operationId: string, leaseToken: string): Promise<LockRow> {
    const now = this.now()
    const nowMs = now.getTime()
    const expiresAt = nowMs + this.leaseMs
    const result = await this.database
      .prepare(
        `insert into service_deployment_locks (
           environment_id, deployment_id, operation_id, lease_token, fencing_token,
           lease_expires_at, acquired_at, heartbeat_at, released_at
         ) values (?, ?, ?, ?, 1, ?, ?, ?, null)
         on conflict(environment_id, deployment_id) do update set
           operation_id = excluded.operation_id,
           lease_token = excluded.lease_token,
           fencing_token = service_deployment_locks.fencing_token + 1,
           lease_expires_at = excluded.lease_expires_at,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           released_at = null
         where service_deployment_locks.lease_expires_at <= ?`,
      )
      .bind(
        scope.environmentId,
        scope.deploymentId,
        operationId,
        leaseToken,
        expiresAt,
        now.toISOString(),
        now.toISOString(),
        nowMs,
      )
      .run()
    if (result.meta.changes !== 1) {
      throw new ServiceDeploymentLockError("busy", "another optional-service workflow owns this deployment")
    }
    const row = await this.row(scope)
    if (!row || row.operationId !== operationId || row.leaseToken !== leaseToken || row.leaseExpiresAt !== expiresAt) {
      throw new ServiceDeploymentLockError("lease_lost", "deployment lock acquisition was superseded")
    }
    return row
  }

  private async renew(scope: Scope, lock: LockRow) {
    const now = this.now()
    const result = await this.database
      .prepare(
        `update service_deployment_locks
         set lease_expires_at = ?, heartbeat_at = ?
         where environment_id = ? and deployment_id = ? and lease_token = ? and fencing_token = ?
           and lease_expires_at > ? and released_at is null`,
      )
      .bind(
        now.getTime() + this.leaseMs,
        now.toISOString(),
        scope.environmentId,
        scope.deploymentId,
        lock.leaseToken,
        lock.fencingToken,
        now.getTime(),
      )
      .run()
    if (result.meta.changes !== 1) {
      throw new ServiceDeploymentLockError("lease_lost", "deployment lock expired or was superseded")
    }
  }

  private async requireCurrent(scope: Scope, lock: LockRow) {
    const current = await this.row(scope)
    if (
      !current ||
      current.leaseToken !== lock.leaseToken ||
      current.fencingToken !== lock.fencingToken ||
      current.leaseExpiresAt <= this.now().getTime()
    ) {
      throw new ServiceDeploymentLockError("lease_lost", "deployment lock expired or was superseded")
    }
  }

  private async release(scope: Scope, lock: LockRow) {
    const now = this.now()
    await this.database
      .prepare(
        `update service_deployment_locks
         set lease_expires_at = 0, heartbeat_at = ?, released_at = ?
         where environment_id = ? and deployment_id = ? and lease_token = ? and fencing_token = ?`,
      )
      .bind(
        now.toISOString(),
        now.toISOString(),
        scope.environmentId,
        scope.deploymentId,
        lock.leaseToken,
        lock.fencingToken,
      )
      .run()
  }

  private row(scope: Scope): Promise<LockRow | null> {
    return this.database
      .prepare(
        `select operation_id as operationId, lease_token as leaseToken,
           fencing_token as fencingToken, lease_expires_at as leaseExpiresAt
         from service_deployment_locks where environment_id = ? and deployment_id = ?`,
      )
      .bind(scope.environmentId, scope.deploymentId)
      .first<LockRow>()
  }
}
