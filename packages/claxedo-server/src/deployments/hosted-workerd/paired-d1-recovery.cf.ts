import type { D1Database } from "@cloudflare/workers-types"

const RECOVERY_EPOCH = /^paired-d1-v1:sha256:[0-9a-f]{64}$/

export type PairedD1RecoveryBinding = Readonly<{
  deploymentId: string
  releaseId: string
  recoveryEpoch: string
}>

function required(value: string, label: string) {
  if (!value.trim() || value.trim() !== value) throw new Error(`${label} must be a canonical non-empty string`)
  return value
}

export function requirePairedD1RecoveryBinding(binding: PairedD1RecoveryBinding) {
  required(binding.deploymentId, "deploymentId")
  required(binding.releaseId, "releaseId")
  if (!RECOVERY_EPOCH.test(binding.recoveryEpoch)) throw new Error("recoveryEpoch is not a paired D1 identity")
  return binding
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function pairedD1RecoveryRegistrationStatements(binding: PairedD1RecoveryBinding, now = new Date()) {
  requirePairedD1RecoveryBinding(binding)
  const createdAt = now.toISOString()
  return Object.freeze({
    auth: `insert into "deploymentRecoveryEpoch"
      ("deploymentId", "releaseId", "recoveryEpoch", "createdAt") values
      (${literal(binding.deploymentId)}, ${literal(binding.releaseId)}, ${literal(binding.recoveryEpoch)}, ${literal(createdAt)})
      on conflict ("deploymentId", "releaseId") do nothing;`,
    controlPlane: `insert into control_plane_recovery_epochs
      (deployment_id, release_id, recovery_epoch, created_at) values
      (${literal(binding.deploymentId)}, ${literal(binding.releaseId)}, ${literal(binding.recoveryEpoch)}, ${literal(createdAt)})
      on conflict (deployment_id, release_id) do nothing;`,
  })
}

export function pairedD1RecoveryControlPlaneVerificationSql(binding: PairedD1RecoveryBinding) {
  requirePairedD1RecoveryBinding(binding)
  return `select deployment_id as "deploymentId", release_id as "releaseId", recovery_epoch as "recoveryEpoch"
    from control_plane_recovery_epochs
    where deployment_id = ${literal(binding.deploymentId)} and release_id = ${literal(binding.releaseId)};`
}

type RecoveryRow = { deploymentId?: unknown; releaseId?: unknown; recoveryEpoch?: unknown }

function requireExactRow(row: RecoveryRow | null, binding: PairedD1RecoveryBinding, database: string) {
  if (
    row?.deploymentId !== binding.deploymentId ||
    row.releaseId !== binding.releaseId ||
    row.recoveryEpoch !== binding.recoveryEpoch
  ) {
    throw new Error(`${database} recovery epoch does not match the active release`)
  }
  return row as { deploymentId: string; releaseId: string; recoveryEpoch: string }
}

export async function requirePairedD1RecoveryEpoch(
  authDatabase: D1Database,
  controlPlaneDatabase: D1Database,
  binding: PairedD1RecoveryBinding,
) {
  requirePairedD1RecoveryBinding(binding)
  const [auth, controlPlane] = await Promise.all([
    authDatabase
      .prepare(
        `select "deploymentId", "releaseId", "recoveryEpoch" from "deploymentRecoveryEpoch"
         where "deploymentId" = ? and "releaseId" = ?`,
      )
      .bind(binding.deploymentId, binding.releaseId)
      .first<RecoveryRow>(),
    controlPlaneDatabase
      .prepare(
        `select deployment_id as "deploymentId", release_id as "releaseId", recovery_epoch as "recoveryEpoch"
         from control_plane_recovery_epochs where deployment_id = ? and release_id = ?`,
      )
      .bind(binding.deploymentId, binding.releaseId)
      .first<RecoveryRow>(),
  ])
  requireExactRow(auth, binding, "AUTH_DB")
  requireExactRow(controlPlane, binding, "CONTROL_PLANE_DB")
  return binding
}

export function verifyPairedD1ControlPlaneRecoveryRow(row: RecoveryRow | null, binding: PairedD1RecoveryBinding) {
  requirePairedD1RecoveryBinding(binding)
  return requireExactRow(row, binding, "CONTROL_PLANE_DB")
}
