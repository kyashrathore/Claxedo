/**
 * The ONE boundary between a stored sandbox-lease row and its typed shape.
 *
 * Both lease stores read the same logical row out of a database that can only
 * promise `string | number | null` per column, and both used to narrow it by
 * hand: `stores/d1.ts` with validating readers, `stores/lease.sql.ts` with bare
 * `as` casts, and `stores/sqlite.ts` with a second hand-copied status union
 * bridged back to the canonical one by `as`. Three answers to one question.
 *
 * Everything a column's raw value has to survive to become a `SandboxLeaseRow`
 * field lives here, and nowhere else.
 */

import type {
  SandboxCheckpointReference,
  SandboxPersistenceCapabilities,
  SandboxRestoreStatus,
} from "@claxedo/sandbox-manager"
import type {
  SandboxComputeClass,
  SandboxHoldRow,
  SandboxLeaseRow,
  SandboxLeaseRowStatus,
} from "@claxedo/sandbox-manager/lease-types"
import { isRecord, parseJson } from "@claxedo/server-core/platform/json/index"

const LEASE_STATUSES: readonly SandboxLeaseRowStatus[] = [
  "pending",
  "acquiring",
  "starting",
  "ready",
  "unhealthy",
  "backoff",
  "stopping",
  "stopped",
  "destroyed",
  "failed",
]

const COMPUTE_CLASSES: readonly SandboxComputeClass[] = ["small", "medium", "large", "gpu"]

const HOLD_OWNER_TYPES: readonly SandboxHoldRow["owner_type"][] = [
  "session",
  "stream",
  "pty",
  "process",
  "system",
]

export function leaseText(input: unknown): string | null {
  return typeof input === "string" ? input : null
}

export function leaseInteger(input: unknown): number | null {
  return typeof input === "number" ? input : null
}

/**
 * An unrecognized stored status reads as `"failed"`, which `sandboxLeaseStatus`
 * maps to the port's `"unavailable"` — the same answer its own fallthrough
 * gives, so a row nobody can interpret is reported unusable rather than
 * silently typed as something it is not.
 */
export function leaseStatus(input: unknown): SandboxLeaseRowStatus {
  return LEASE_STATUSES.find((status) => status === input) ?? "failed"
}

export function leaseComputeClass(input: unknown): SandboxComputeClass | null {
  return COMPUTE_CLASSES.find((computeClass) => computeClass === input) ?? null
}

export function holdOwnerType(input: unknown): SandboxHoldRow["owner_type"] {
  return HOLD_OWNER_TYPES.find((ownerType) => ownerType === input) ?? "system"
}

/**
 * The driver id a row was written with, or `""` when the column holds anything
 * but a string.
 *
 * A driver can be registered with the manager under any id
 * (`stores/d1.test.ts` provisions one called `"test-provider"`), so there is no
 * closed set to narrow to here and none is claimed: `SandboxLeaseRow["driver"]`
 * is `string`, like every other type this value flows between.
 * `stores/lease.sql.ts`, `stores/d1.ts` and `stores/sqlite.ts` each carried
 * their own cast into the closed `SandboxDriverID` (the last as `as never`);
 * they now share this reader and none of them asserts.
 */
export function leaseDriver(input: unknown): string {
  return leaseText(input) ?? ""
}

/**
 * A JSON column is only trusted when it parses AND yields an object. SQLite's
 * `json_valid` accepts `"1"` and `"null"` too, neither of which is a lease
 * field, so a bare cast would hand the manager a number typed as a checkpoint
 * reference.
 */
function leaseJsonRecord(input: unknown): Record<string, unknown> | null {
  const raw = leaseText(input)
  if (!raw) return null
  try {
    const parsed = parseJson(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function leaseLabels(input: unknown): Record<string, string> | null {
  const parsed = leaseJsonRecord(input)
  if (!parsed) return null
  const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return Object.fromEntries(entries)
}

type CheckpointMetadata = SandboxCheckpointReference["metadata"]

const CAPTURE_SCOPES: readonly CheckpointMetadata["scope"][] = ["same-resource", "filesystem", "directories"]
const CAPTURE_SOURCE_BEHAVIORS: readonly CheckpointMetadata["sourceBehavior"][] = [
  "preserved",
  "stopped",
  "deleted",
]
const RESTORE_MOUNTS: readonly CheckpointMetadata["restoreMount"][] = [
  "same-resource",
  "copy-on-write",
  "new-resource",
]

function isCheckpointMetadata(value: unknown): value is CheckpointMetadata {
  return (
    isRecord(value) &&
    CAPTURE_SCOPES.some((scope) => scope === value.scope) &&
    CAPTURE_SOURCE_BEHAVIORS.some((behavior) => behavior === value.sourceBehavior) &&
    RESTORE_MOUNTS.some((mount) => mount === value.restoreMount) &&
    (value.retentionExpiresAt === undefined || typeof value.retentionExpiresAt === "number")
  )
}

function isCheckpointReference(value: Record<string, unknown>): value is SandboxCheckpointReference {
  return (
    typeof value.id === "string" &&
    typeof value.providerReference === "string" &&
    typeof value.sourceEpoch === "number" &&
    typeof value.capturedAt === "number" &&
    isCheckpointMetadata(value.metadata)
  )
}

export function leaseCheckpoint(input: unknown): SandboxCheckpointReference | null {
  const parsed = leaseJsonRecord(input)
  return parsed && isCheckpointReference(parsed) ? parsed : null
}

const RESUME_MODES: readonly SandboxPersistenceCapabilities["resume"][] = ["same-sandbox", "replacement-restore"]
const RETENTIONS: readonly SandboxPersistenceCapabilities["retention"][] = [
  "not-applicable",
  "provider-managed",
  "explicit",
]

function isPersistenceCapabilities(value: Record<string, unknown>): value is SandboxPersistenceCapabilities {
  return (
    RESUME_MODES.some((resume) => resume === value.resume) &&
    (value.capture === "none" || CAPTURE_SCOPES.some((scope) => scope === value.capture)) &&
    typeof value.clone === "boolean" &&
    (value.captureSource === "not-applicable" ||
      CAPTURE_SOURCE_BEHAVIORS.some((behavior) => behavior === value.captureSource)) &&
    RETENTIONS.some((retention) => retention === value.retention) &&
    (value.restoreMount === "not-applicable" || RESTORE_MOUNTS.some((mount) => mount === value.restoreMount))
  )
}

export function leasePersistence(input: unknown): SandboxPersistenceCapabilities | null {
  const parsed = leaseJsonRecord(input)
  return parsed && isPersistenceCapabilities(parsed) ? parsed : null
}

function isRestoreStatus(value: Record<string, unknown>): value is SandboxRestoreStatus {
  if (
    typeof value.checkpointId !== "string" ||
    typeof value.sourceEpoch !== "number" ||
    typeof value.requestedAt !== "number"
  ) {
    return false
  }
  // Each state carries its own timestamps; a row missing them is not that state.
  if (value.state === "pending") return true
  if (value.state === "restoring") return typeof value.startedAt === "number"
  if (value.state === "ready") return typeof value.startedAt === "number" && typeof value.completedAt === "number"
  if (value.state === "failed") {
    return (
      typeof value.failedAt === "number" &&
      typeof value.error === "string" &&
      (value.startedAt === undefined || typeof value.startedAt === "number")
    )
  }
  return false
}

export function leaseRestore(input: unknown): SandboxRestoreStatus | null {
  const parsed = leaseJsonRecord(input)
  return parsed && isRestoreStatus(parsed) ? parsed : null
}

/**
 * Column names differ between the two stores (D1 stores `url`/`labels_json`,
 * the local SQLite schema stores `runtime_url`/`labels`), so each store hands
 * this the already-selected raw values rather than a row object.
 */
export type RawLeaseColumns = { readonly [K in keyof SandboxLeaseRow]?: unknown }

export function toSandboxLeaseRow(columns: RawLeaseColumns): SandboxLeaseRow {
  const workspaceId = leaseText(columns.workspace_id) ?? ""
  return {
    workspace_id: workspaceId,
    lease_id: leaseText(columns.lease_id) ?? "",
    home_region: leaseText(columns.home_region) ?? undefined,
    epoch: leaseInteger(columns.epoch) ?? 0,
    status: leaseStatus(columns.status),
    driver: leaseDriver(columns.driver),
    driver_resource_id: leaseText(columns.driver_resource_id),
    driver_snapshot_id: leaseText(columns.driver_snapshot_id),
    sandbox_id: leaseText(columns.sandbox_id),
    url: leaseText(columns.url),
    retry_count: leaseInteger(columns.retry_count) ?? 0,
    next_retry_at: leaseInteger(columns.next_retry_at),
    last_heartbeat_at: leaseInteger(columns.last_heartbeat_at),
    last_activity_at: leaseInteger(columns.last_activity_at),
    last_health_failure_at: leaseInteger(columns.last_health_failure_at),
    last_error: leaseText(columns.last_error),
    compute_class: leaseComputeClass(columns.compute_class),
    accel_base_image_id: leaseText(columns.accel_base_image_id),
    accel_prepared_image_id: leaseText(columns.accel_prepared_image_id),
    accel_snapshot_id: leaseText(columns.accel_snapshot_id),
    labels: leaseLabels(columns.labels),
    checkpoint: leaseCheckpoint(columns.checkpoint),
    persistence: leasePersistence(columns.persistence),
    restore: leaseRestore(columns.restore),
    created_at: leaseInteger(columns.created_at) ?? 0,
    updated_at: leaseInteger(columns.updated_at) ?? 0,
  }
}
