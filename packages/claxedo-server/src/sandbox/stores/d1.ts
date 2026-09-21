/**
 * `SandboxLeaseStore` over Cloudflare D1.
 *
 * Semantically identical to the local SQLite store (`./sqlite.ts`) — same
 * acquire/refuse rules, same epoch compare-and-set, same row<->port status
 * conversion via `sandboxLeaseStatus`. The ONE difference is how atomicity is
 * obtained: the SQLite store wraps read+write in `leaseTransaction`, while D1
 * has no multi-statement transaction. Here every write is instead a SINGLE
 * statement guarded by the epoch the caller observed, so a lost race is
 * reported by the write itself (`meta.changes === 0`) rather than prevented by
 * a lock. A loser re-reads and answers from the winner's row, which is exactly
 * what the transactional store would have produced for the second caller.
 */

import { applySandboxLeasePatch, applySandboxProvisionedTarget } from "@claxedo/sandbox-manager"
import type {
  SandboxLease,
  SandboxLeaseAcquireInput,
  SandboxLeaseAcquireResult,
  SandboxLeasePatch,
  SandboxLeaseStatus,
  SandboxLeaseStore,
  SandboxProvisionedTarget,
} from "@claxedo/sandbox-manager"
import type { SandboxLeaseRow } from "@claxedo/sandbox-manager/lease-types"
import type { D1Database } from "@cloudflare/workers-types"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import { sandboxLeaseRowStatus, sandboxLeaseStatus } from "./lease-status"
import { toSandboxLeaseRow } from "./lease-row"

const TABLE = "sandbox_leases"

const COLUMNS = [
  "workspace_id",
  "lease_id",
  "home_region",
  "epoch",
  "status",
  "driver",
  "driver_resource_id",
  "driver_snapshot_id",
  "sandbox_id",
  "url",
  "retry_count",
  "next_retry_at",
  "last_heartbeat_at",
  "last_activity_at",
  "last_health_failure_at",
  "last_error",
  "compute_class",
  "accel_base_image_id",
  "accel_prepared_image_id",
  "accel_snapshot_id",
  "labels_json",
  "checkpoint_json",
  "persistence_json",
  "restore_json",
  "created_at",
  "updated_at",
] as const

/** Everything except the primary key and `created_at`, which an upsert preserves. */
const CONFLICT_COLUMNS = COLUMNS.filter((column) => column !== "workspace_id" && column !== "created_at")

const PATCH_COLUMNS = [
  ["status", "status"], ["retryCount", "retry_count"], ["nextRetryAt", "next_retry_at"],
  ["lastHeartbeatAt", "last_heartbeat_at"], ["lastActivityAt", "last_activity_at"], ["lastError", "last_error"],
  ["checkpoint", "checkpoint_json"], ["restore", "restore_json"],
] as const satisfies ReadonlyArray<readonly [keyof SandboxLeasePatch, typeof COLUMNS[number]]>

/**
 * D1 hands back `Record<string, unknown>`; the narrowing every column needs is
 * `./lease-row`'s, and all this does is map this table's `*_json` column names
 * onto the shared ones.
 */
function toLeaseRow(row: Record<string, unknown>): SandboxLeaseRow {
  return toSandboxLeaseRow({
    ...row,
    labels: row.labels_json,
    checkpoint: row.checkpoint_json,
    persistence: row.persistence_json,
    restore: row.restore_json,
  })
}

function toSandboxLease(input: SandboxLeaseRow): SandboxLease {
  return {
    workspaceId: input.workspace_id,
    homeRegion: normalizeClaxedoRegion(input.home_region),
    driver: input.driver,
    epoch: input.epoch,
    status: sandboxLeaseStatus(input.status),
    retryCount: input.retry_count,
    createdAt: input.created_at,
    updatedAt: input.updated_at,
    sandboxId: input.sandbox_id ?? undefined,
    url: input.url ?? undefined,
    hostId: input.lease_id,
    driverResourceId: input.driver_resource_id ?? undefined,
    nextRetryAt: input.next_retry_at ?? undefined,
    lastError: input.last_error ?? undefined,
    lastHeartbeatAt: input.last_heartbeat_at ?? undefined,
    lastActivityAt: input.last_activity_at ?? undefined,
    labels: input.labels ?? undefined,
    checkpoint: input.checkpoint ?? undefined,
    persistence: input.persistence ?? undefined,
    restore: input.restore ?? undefined,
  }
}

function json(input: unknown): string | null {
  return input === undefined || input === null ? null : JSON.stringify(input)
}

/** The full column tuple `write()` in `sqlite.ts` builds, in `COLUMNS` order. */
function rowValues(
  lease: SandboxLease,
  current: SandboxLeaseRow | undefined,
  options?: { lastHealthFailureAt?: number },
): (string | number | null)[] {
  return [
    lease.workspaceId,
    lease.hostId ?? current?.lease_id ?? `${lease.workspaceId}:${lease.epoch}`,
    lease.homeRegion,
    lease.epoch,
    sandboxLeaseRowStatus(lease),
    lease.driver,
    lease.driverResourceId ?? null,
    current?.driver_snapshot_id ?? null,
    lease.sandboxId ?? null,
    lease.url ?? null,
    lease.retryCount,
    lease.nextRetryAt ?? null,
    lease.lastHeartbeatAt ?? null,
    lease.lastActivityAt ?? null,
    options?.lastHealthFailureAt ?? current?.last_health_failure_at ?? null,
    lease.lastError ?? null,
    current?.compute_class ?? null,
    current?.accel_base_image_id ?? null,
    current?.accel_prepared_image_id ?? null,
    current?.accel_snapshot_id ?? null,
    json(lease.labels),
    json(lease.checkpoint),
    json(lease.persistence),
    json(lease.restore),
    lease.createdAt,
    lease.updatedAt,
  ]
}

/**
 * The refusal a caller gets when a lease it cannot take already exists —
 * either read before writing, or read back after losing a guarded write.
 */
function refusal(lease: SandboxLease, now: number, staleAfterMs: number): SandboxLeaseAcquireResult | undefined {
  if (lease.status === "ready") return { acquired: false, lease, retryAfterMs: 0 }
  if (lease.status === "acquiring" && now - lease.updatedAt < staleAfterMs) {
    return { acquired: false, lease, retryAfterMs: Math.max(0, staleAfterMs - (now - lease.updatedAt)) }
  }
  return undefined
}

export function createD1SandboxLeaseStore(input: { database: D1Database; now?: () => number }): SandboxLeaseStore {
  const database = input.database
  const clock = input.now ?? (() => Date.now())

  async function read(workspaceId: string): Promise<SandboxLeaseRow | undefined> {
    const row = await database
      .prepare(`select * from ${TABLE} where workspace_id = ?`)
      .bind(workspaceId)
      .first()
    return row ? toLeaseRow(row) : undefined
  }

  /** Write only this operation's fields; a delayed health write must never restore stale identity. */
  async function writeFenced(
    workspaceId: string,
    expectedEpoch: number,
    next: SandboxLease,
    current: SandboxLeaseRow,
    columns: readonly typeof COLUMNS[number][],
    expectedStatus?: string,
    lastHealthFailureAt?: number,
  ) {
    const values = rowValues(next, current, { lastHealthFailureAt })
    const result = await database
      .prepare(
        `update ${TABLE} set ${columns.map((column) => `${column} = ?`).join(", ")}
         where workspace_id = ? and epoch = ?${expectedStatus === undefined ? "" : " and status = ?"} returning *`,
      )
      .bind(
        ...columns.map((column) => values[COLUMNS.indexOf(column)] ?? null),
        workspaceId,
        expectedEpoch,
        ...(expectedStatus === undefined ? [] : [expectedStatus]),
      )
      .first()
    return result ? toSandboxLease(toLeaseRow(result)) : undefined
  }

  /**
   * One acquire attempt. Returns `undefined` when the guarded write lost the
   * race, which tells the caller to re-read and decide again.
   */
  async function attempt(
    workspaceId: string,
    acquireInput: SandboxLeaseAcquireInput,
    now: number,
  ): Promise<SandboxLeaseAcquireResult | undefined> {
    const current = await read(workspaceId)
    const currentLease = current ? toSandboxLease(current) : undefined
    if (currentLease) {
      const refused = refusal(currentLease, now, acquireInput.staleAfterMs)
      if (refused) return refused
    }
    const resumable = currentLease?.status === "stopped"
    const next: SandboxLease = {
      workspaceId,
      homeRegion: currentLease?.homeRegion ?? acquireInput.homeRegion,
      driver: currentLease?.driver ?? acquireInput.driver,
      epoch: (currentLease?.epoch ?? 0) + 1,
      status: "acquiring",
      retryCount: currentLease?.retryCount ?? 0,
      createdAt: currentLease?.createdAt ?? now,
      updatedAt: now,
      sandboxId: resumable ? currentLease.sandboxId : undefined,
      url: resumable ? currentLease.url : undefined,
      hostId: resumable ? currentLease.hostId : undefined,
      driverResourceId: resumable ? currentLease.driverResourceId : undefined,
      lastHeartbeatAt: resumable ? currentLease.lastHeartbeatAt : undefined,
      lastActivityAt: resumable ? currentLease.lastActivityAt : undefined,
      labels: resumable ? currentLease.labels : undefined,
      checkpoint: currentLease?.checkpoint,
      persistence: currentLease?.persistence,
      restore: currentLease?.restore,
    }
    const values = rowValues(next, current)
    // No row observed: only an insert that actually inserts may win. An isolate
    // that created the row in between conflicts and changes nothing.
    // Row observed: the upsert may only overwrite the epoch it read.
    const statement = current
      ? `insert into ${TABLE} (${COLUMNS.join(", ")}) values (${COLUMNS.map(() => "?").join(", ")})
         on conflict(workspace_id) do update set ${CONFLICT_COLUMNS.map((column) => `${column} = excluded.${column}`).join(", ")}
         where ${TABLE}.epoch = ?`
      : `insert into ${TABLE} (${COLUMNS.join(", ")}) values (${COLUMNS.map(() => "?").join(", ")})
         on conflict(workspace_id) do nothing`
    const result = await database
      .prepare(statement)
      .bind(...(current ? [...values, current.epoch] : values))
      .run()
    return result.meta.changes === 0 ? undefined : { acquired: true, lease: next }
  }

  return {
    async acquire(workspaceId: string, acquireInput: SandboxLeaseAcquireInput): Promise<SandboxLeaseAcquireResult> {
      const now = acquireInput.now ?? clock()
      // Bounded, because every retry follows a write that another isolate won:
      // the row now exists and the next pass either refuses on it or wins.
      for (let pass = 0; pass < 3; pass += 1) {
        const result = await attempt(workspaceId, acquireInput, now)
        if (result) return result
      }
      const winner = await read(workspaceId)
      const lease = winner ? toSandboxLease(winner) : undefined
      if (lease) return refusal(lease, now, acquireInput.staleAfterMs) ?? { acquired: false, lease, retryAfterMs: 0 }
      throw new Error(`sandbox lease for ${workspaceId} could not be acquired or read`)
    },

    async recordTarget(workspaceId: string, expectedEpoch: number, target: SandboxProvisionedTarget) {
      const current = await read(workspaceId)
      if (!current || current.epoch !== expectedEpoch) return undefined
      if (sandboxLeaseStatus(current.status) === "stopped" || sandboxLeaseStatus(current.status) === "destroyed") return undefined
      return await writeFenced(
        workspaceId,
        expectedEpoch,
        applySandboxProvisionedTarget(toSandboxLease(current), target, clock()),
        current,
        ["lease_id", "sandbox_id", "url", "driver_resource_id", "labels_json", "persistence_json", "status", "retry_count", "next_retry_at", "last_error", "updated_at"],
        current.status,
      )
    },

    async update(workspaceId: string, expectedEpoch: number, patch: SandboxLeasePatch, expectedStatus?: SandboxLeaseStatus) {
      const current = await read(workspaceId)
      if (!current || current.epoch !== expectedEpoch) return undefined
      if (expectedStatus !== undefined && sandboxLeaseStatus(current.status) !== expectedStatus) return undefined
      const columns = new Set<typeof COLUMNS[number]>(["updated_at"])
      for (const [key, column] of PATCH_COLUMNS) {
        if (patch[key] !== undefined) columns.add(column)
      }
      // The stored unavailable state distinguishes retry backoff from failure.
      if (patch.nextRetryAt !== undefined) columns.add("status")
      return await writeFenced(
        workspaceId,
        expectedEpoch,
        applySandboxLeasePatch(toSandboxLease(current), patch, clock()),
        current,
        [...columns],
        expectedStatus === undefined ? undefined : current.status,
      )
    },

    async recordFailure(workspaceId: string, expectedEpoch: number, error: string, nextRetryAt?: number) {
      const current = await read(workspaceId)
      if (!current || current.epoch !== expectedEpoch) return undefined
      if (sandboxLeaseStatus(current.status) === "stopped" || sandboxLeaseStatus(current.status) === "destroyed") return undefined
      const failedAt = clock()
      const next: SandboxLease = {
        ...toSandboxLease(current),
        status: "unavailable",
        retryCount: current.retry_count + 1,
        lastError: error,
        nextRetryAt,
        updatedAt: failedAt,
      }
      return await writeFenced(workspaceId, expectedEpoch, next, current,
        ["status", "retry_count", "next_retry_at", "last_error", "last_health_failure_at", "updated_at"], current.status, failedAt)
    },

    async release(workspaceId: string) {
      await database.prepare(`delete from ${TABLE} where workspace_id = ?`).bind(workspaceId).run()
    },

    async get(workspaceId: string) {
      const current = await read(workspaceId)
      return current ? toSandboxLease(current) : undefined
    },

    async list() {
      const rows = await database.prepare(`select * from ${TABLE}`).all()
      return rows.results.map((row) => toSandboxLease(toLeaseRow(row)))
    },
  }
}
