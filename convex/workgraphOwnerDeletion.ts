import { v } from "convex/values"
import { serviceMutation } from "./model"
import { requireTrustedWorkGraphTenantSubject } from "./workgraphModel"

const deletionLeaseMs = 5 * 60 * 1_000
export const WORKGRAPH_OWNER_DELETION_BATCH_SIZE = 8

/**
 * WorkGraph-adjacent tables the per-OWNER purge deliberately does NOT touch,
 * with the reason. The deliberate mirror of `ORG_RETAINED_TABLES` in
 * convex/orgs.ts, and load-bearing for the same reason: `WORKGRAPH_OWNER_TABLES`
 * is derived by predicate (`convex-owner-deletion.test.ts` matches every
 * `workgraph*`/`work_*` table carrying `owner_user_id`), so a table WITHOUT
 * that column drops out of the cascade silently — indistinguishable from an
 * oversight. Naming it here turns the omission into a decision on the record.
 *
 * The org-level cascade is a separate question and covers these; see
 * `ORG_PURGED_TABLES`.
 */
export const WORKGRAPH_OWNER_RETAINED_TABLES: Readonly<Record<string, string>> = {
  // Org-owned, not user-owned: keyed `organization_id` + `connection_id` with
  // no owner column at all (convex/schema.ts). Every hosted connection is
  // created as `org:{orgId}` because the hosted routes expose no personal owner
  // resolver, so a connection is SHARED — deleting one member of a three-person
  // org must not destroy the org's GitHub connection for the other two. Org
  // deletion reaps these through `ORG_CONNECTION_CASCADE`, which is the correct
  // scope. Self-host is where personal connections exist, and its cascade runs
  // in the server (`server-workgraph.ts`), not here.
  workgraph_connection_metadata: "org-owned and shared; no owner column; reaped by the ORG cascade",
  // Child of the connection above, scoped only by `connection_id`. Follows its
  // parent for the same reason.
  workgraph_webhook_deliveries: "child of workgraph_connection_metadata; follows its parent's scope",
  // This cascade's OWN bookkeeping, and it must outlive the rows it deleted:
  // it is what lets an exact retry of a completed operation replay the original
  // result after every owner-scoped row is gone. Hash-only by construction
  // (`owner_subject_hash`, `operation_hash`), so it retains no identity to
  // erase. Purging it here would make the purge un-replayable.
  workgraph_owner_deletion_receipts: "hashes only; the receipt that survives to replay this deletion",
}

export const WORKGRAPH_OWNER_TABLES = [
  "workgraph_attention_entries",
  "workgraph_attention_summaries",
  "workgraph_run_connection_bindings",
  "workgraph_decision_work_items",
  "workgraph_evidence",
  "workgraph_durable_effect_receipts",
  "workgraph_record_source_revisions",
  "workgraph_work_item_dependencies",
  "workgraph_changes",
  "workgraph_dirty_events",
  "workgraph_events",
  "workgraph_outbox",
  "workgraph_due_jobs",
  "workgraph_cleanup_receipts",
  "workgraph_runtime_effects",
  "workgraph_leases",
  "workgraph_agent_checkpoints",
  "workgraph_session_bindings",
  "workgraph_runs",
  "workgraph_decisions",
  "workgraph_work_items",
  "workgraph_outcomes",
  "workgraph_master_mailbox",
  "workgraph_stream_sequences",
  "workgraph_streams",
  "workgraph_external_identities",
  "workgraph_admission_proposals",
  "workgraph_intake_candidates",
  "workgraph_source_views",
  "work_source_revisions",
  "work_sources",
  "workgraph_archive_restores",
  "workgraph_migration_intake",
  "workgraph_tenancy_migration_quarantine",
  "workgraph_operation_results",
  "workgraphs",
  "workgraph_execution_capabilities",
] as const

type CleanupTarget = Readonly<{
  streamId: string
  envelopeId: string
  childIsolationIds: readonly string[]
}>

export const prepareForService = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    operation_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return prepareWorkGraphOwnerDeletion(ctx, String(tenant.organization_id), String(tenant.owner_user_id), args.operation_id, args.now)
  },
})

export const finalizeForService = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    operation_id: v.string(),
    target_snapshot_hash: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return finalizeWorkGraphOwnerDeletion(
      ctx,
      String(tenant.organization_id),
      String(tenant.owner_user_id),
      args.operation_id,
      args.target_snapshot_hash,
      args.now,
    )
  },
})

export const renewForService = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    operation_id: v.string(),
    target_snapshot_hash: v.string(),
    renew_only: v.literal(true),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return renewWorkGraphOwnerDeletion(
      ctx,
      String(tenant.organization_id),
      String(tenant.owner_user_id),
      args.operation_id,
      args.target_snapshot_hash,
      args.now,
    )
  },
})

export const releaseForService = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    operation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return releaseWorkGraphOwnerDeletion(ctx, String(tenant.organization_id), String(tenant.owner_user_id), args.operation_id)
  },
})

export async function prepareWorkGraphOwnerDeletion(
  ctx: any,
  organization: string,
  owner: string,
  operationId: string,
  now: number,
) {
  const ownerSubjectHash = await sha256(`${organization}\u0000${owner}`)
  const operationHash = await sha256(operationId)
  const receipt = await ctx.db.query("workgraph_owner_deletion_receipts")
    .withIndex("by_owner_operation", (query: any) =>
      query.eq("owner_subject_hash", ownerSubjectHash).eq("operation_hash", operationHash))
    .unique()
  if (receipt?.state === "completed") {
    return { ok: true as const, state: "completed" as const, result: receipt.result }
  }
  const barrier = await ownerDeletionBarrier(ctx, organization, owner)
  if (barrier?.operation_hash === operationHash && receipt?.state === "deleting") {
    await renewDeletion(ctx, barrier, receipt, now)
    return { ok: true as const, state: "deleting" as const, targetSnapshotHash: receipt.target_snapshot_hash }
  }
  if (barrier?.operation_hash === operationHash && receipt?.state === "cleaning" && barrier.lease_expires_at <= now) {
    await renewDeletion(ctx, barrier, receipt, now)
    return {
      ok: true as const,
      state: "acquired" as const,
      targets: receipt.targets ?? [],
      targetSnapshotHash: receipt.target_snapshot_hash,
    }
  }
  if (barrier?.operation_hash === operationHash) return { ok: true as const, state: "in_progress" as const }
  if (barrier) {
    const blockedReceipt = await ctx.db.query("workgraph_owner_deletion_receipts")
      .withIndex("by_owner_operation", (query: any) =>
        query.eq("owner_subject_hash", ownerSubjectHash).eq("operation_hash", barrier.operation_hash))
      .unique()
    if (barrier.lease_expires_at > now || blockedReceipt?.state === "deleting") {
      return { ok: true as const, state: "in_progress" as const }
    }
    await ctx.db.delete(barrier._id)
    if (blockedReceipt?.state === "cleaning") await ctx.db.delete(blockedReceipt._id)
  }
  if (receipt?.state === "deleting") {
    await ctx.db.insert("workgraph_owner_deletion_barriers", {
      organization_id: organization,
      owner_user_id: owner,
      operation_hash: operationHash,
      lease_expires_at: now + deletionLeaseMs,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.patch(receipt._id, { lease_expires_at: now + deletionLeaseMs, updated_at: now })
    return { ok: true as const, state: "deleting" as const, targetSnapshotHash: receipt.target_snapshot_hash }
  }
  if (!await isQuiescent(ctx, organization, owner)) return { ok: false as const, reason: "not_quiescent" as const }

  const targets = receipt?.targets ?? await readCleanupTargets(ctx, organization, owner)
  const targetSnapshotHash = await sha256(stableJson(targets))
  await ctx.db.insert("workgraph_owner_deletion_barriers", {
    organization_id: organization,
    owner_user_id: owner,
    operation_hash: operationHash,
    lease_expires_at: now + deletionLeaseMs,
    created_at: now,
    updated_at: now,
  })
  const next = {
    owner_subject_hash: ownerSubjectHash,
    operation_hash: operationHash,
    state: "cleaning" as const,
    target_snapshot_hash: targetSnapshotHash,
    targets,
    result: undefined,
    deleted_record_count: 0,
    lease_expires_at: now + deletionLeaseMs,
    updated_at: now,
  }
  if (receipt) await ctx.db.patch(receipt._id, next)
  if (!receipt) await ctx.db.insert("workgraph_owner_deletion_receipts", { ...next, created_at: now })
  return { ok: true as const, state: "acquired" as const, targets, targetSnapshotHash }
}

export async function finalizeWorkGraphOwnerDeletion(
  ctx: any,
  organization: string,
  owner: string,
  operationId: string,
  targetSnapshotHash: string,
  now: number,
) {
  const ownerSubjectHash = await sha256(`${organization}\u0000${owner}`)
  const operationHash = await sha256(operationId)
  const receipt = await ctx.db.query("workgraph_owner_deletion_receipts")
    .withIndex("by_owner_operation", (query: any) =>
      query.eq("owner_subject_hash", ownerSubjectHash).eq("operation_hash", operationHash))
    .unique()
  const barrier = await ownerDeletionBarrier(ctx, organization, owner)
  if (receipt?.state === "completed") {
    return { ok: true as const, result: receipt.result }
  }
  if (!receipt || !["cleaning", "deleting"].includes(receipt.state) || receipt.target_snapshot_hash !== targetSnapshotHash ||
    (receipt.state === "cleaning" && !Array.isArray(receipt.targets)) || barrier?.operation_hash !== operationHash ||
    receipt.lease_expires_at <= now || barrier.lease_expires_at <= now) {
    return { ok: false as const, reason: "in_progress" as const }
  }
  if (receipt.state === "cleaning") {
    if (!await isQuiescent(ctx, organization, owner)) return { ok: false as const, reason: "not_quiescent" as const }
    if (await sha256(stableJson(await readCleanupTargets(ctx, organization, owner))) !== targetSnapshotHash) {
      return { ok: false as const, reason: "not_quiescent" as const }
    }
  }

  const batch = await deleteOwnerRecordBatch(ctx, organization, owner)
  const recordCount = (receipt.deleted_record_count ?? 0) + batch.deleted
  if (!batch.complete) {
    await ctx.db.patch(barrier._id, { lease_expires_at: now + deletionLeaseMs, updated_at: now })
    await ctx.db.patch(receipt._id, {
      state: "deleting",
      deleted_record_count: recordCount,
      lease_expires_at: now + deletionLeaseMs,
      updated_at: now,
    })
    return { ok: true as const, state: "deleting" as const, targetSnapshotHash }
  }

  const result = {
    deleted: true as const,
    recordCount,
    workspaceCount: receipt.targets?.length ?? 0,
    completedAt: now,
  }
  await ctx.db.delete(barrier._id)
  await ctx.db.patch(receipt._id, {
    state: "completed",
    targets: undefined,
    deleted_record_count: undefined,
    result,
    lease_expires_at: 0,
    updated_at: now,
  })
  return { ok: true as const, result }
}

export async function renewWorkGraphOwnerDeletion(
  ctx: any,
  organization: string,
  owner: string,
  operationId: string,
  targetSnapshotHash: string,
  now: number,
) {
  const ownerSubjectHash = await sha256(`${organization}\u0000${owner}`)
  const operationHash = await sha256(operationId)
  const receipt = await ctx.db.query("workgraph_owner_deletion_receipts")
    .withIndex("by_owner_operation", (query: any) =>
      query.eq("owner_subject_hash", ownerSubjectHash).eq("operation_hash", operationHash))
    .unique()
  const barrier = await ownerDeletionBarrier(ctx, organization, owner)
  if (receipt?.state !== "cleaning" || receipt.target_snapshot_hash !== targetSnapshotHash ||
    barrier?.operation_hash !== operationHash || receipt.lease_expires_at <= now || barrier.lease_expires_at <= now) {
    return { ok: false as const, reason: "in_progress" as const }
  }
  await renewDeletion(ctx, barrier, receipt, now)
  return { ok: true as const, state: "renewed" as const }
}

export async function releaseWorkGraphOwnerDeletion(ctx: any, organization: string, owner: string, operationId: string) {
  const ownerSubjectHash = await sha256(`${organization}\u0000${owner}`)
  const operationHash = await sha256(operationId)
  const receipt = await ctx.db.query("workgraph_owner_deletion_receipts")
    .withIndex("by_owner_operation", (query: any) => query
      .eq("owner_subject_hash", ownerSubjectHash)
      .eq("operation_hash", operationHash))
    .unique()
  const barrier = await ownerDeletionBarrier(ctx, organization, owner)
  if (receipt?.state === "cleaning") {
    if (barrier?.operation_hash === operationHash) await ctx.db.delete(barrier._id)
    await ctx.db.delete(receipt._id)
  }
  return { ok: true as const }
}

async function readCleanupTargets(ctx: any, organization: string, owner: string): Promise<readonly CleanupTarget[]> {
  const [streams, runs] = await Promise.all([
    ownerRows(ctx, "workgraph_streams", organization, owner),
    ownerRows(ctx, "workgraph_runs", organization, owner),
  ])
  const streamIds: string[] = [...new Set<string>([
    ...streams.map((stream: any) => String(stream.id)),
    ...runs.filter((run: any) => run.envelope_id).map((run: any) => String(run.stream_id)),
  ])].sort()
  return streamIds.flatMap((streamId) => {
    const stream = streams.find((candidate: any) => candidate.id === streamId)
    if (stream?.envelope?.status === "destroyed") return []
    const envelopeIds = new Set<string>()
    const storedEnvelope = stream?.envelope
    if (storedEnvelope !== undefined) {
      const value = exactString(storedEnvelope.id) ?? exactString(storedEnvelope.workspaceId)
      if (!value) throw new Error("Stored Stream envelope has no exact identity")
      envelopeIds.add(value)
    }
    runs.filter((run: any) => run.stream_id === streamId).forEach((run: any) => {
      const value = exactString(run.envelope_id)
      if (value) envelopeIds.add(value)
    })
    if (envelopeIds.size === 0) return []
    if (envelopeIds.size !== 1) throw new Error("Stream has conflicting execution envelope identities")
    const childIsolationIds: string[] = [...new Set<string>(runs
      .filter((run: any) => run.stream_id === streamId)
      .map((run: any) => exactString(run.child_workspace_id))
      .filter((value: string | undefined): value is string => value !== undefined))].sort()
    return [{ streamId, envelopeId: [...envelopeIds][0]!, childIsolationIds }]
  })
}

async function isQuiescent(ctx: any, organization: string, owner: string) {
  const [runs, leases, runtimeEffects, bindings, proposals, outbox, jobs] = await Promise.all([
    ownerRows(ctx, "workgraph_runs", organization, owner),
    ownerRows(ctx, "workgraph_leases", organization, owner),
    ownerRows(ctx, "workgraph_runtime_effects", organization, owner),
    ownerRows(ctx, "workgraph_run_connection_bindings", organization, owner),
    ownerRows(ctx, "workgraph_admission_proposals", organization, owner),
    ownerRows(ctx, "workgraph_outbox", organization, owner),
    ownerRows(ctx, "workgraph_due_jobs", organization, owner),
  ])
  return !runs.some((row: any) => ["admitted", "placing", "running", "parked"].includes(row.state))
    && leases.length === 0
    && !runtimeEffects.some((row: any) => row.state !== "completed")
    && !bindings.some((row: any) => row.revoked_at === undefined)
    && !proposals.some((row: any) => row.state === "planning")
    && !outbox.some((row: any) => row.status !== "completed")
    && !jobs.some((row: any) => ["pending", "running", "claimed"].includes(row.status))
}

/**
 * The index each owner-scoped table is enumerated through, where it is NOT the
 * default `by_tenant`.
 *
 * FIXED 2026-07-30. This used to be an inline `table === quarantine ? … :
 * "by_tenant"` ternary, i.e. "every other table has `by_tenant`" — and three of
 * them do not. `workgraph_dirty_events`, `workgraph_agent_checkpoints`, and
 * `workgraph_session_bindings` never declared it, so against the real Convex
 * runtime the cascade THREW on those tables: an owner deletion could not run to
 * completion, and the rows it was supposed to erase stayed. It was invisible in
 * tests because every hand-rolled Convex `db` double ignored the index NAME and
 * behaved like a plain field filter (now fixed — see
 * `claxedo-server/src/test-support/convex-index-harness.ts`).
 *
 * No schema change was needed: each of the three already carries an index whose
 * first two fields are exactly `["organization_id", "owner_user_id"]`, so a
 * two-`eq` prefix range over it returns EVERY row for the tenant regardless of
 * the trailing field — which is what deletion completeness requires. The
 * trailing fields (`dirty_token`, `id`) are non-optional in the schema, so no
 * row can fall outside the range.
 *
 * A missing entry here means "this table uses `by_tenant`", and that assumption
 * is now ASSERTED rather than assumed: the guard in
 * `claxedo-server/src/control-plane/convex-unbounded-read-guard.test.ts` checks
 * every table in `WORKGRAPH_OWNER_TABLES` actually declares the index this map
 * resolves to, and that the index is tenant-scoped. Adding a table with a
 * differently-named tenant index fails that test instead of throwing in
 * production.
 */
export const WORKGRAPH_OWNER_DELETION_INDEXES: Readonly<Record<string, string>> = {
  // Tenant-prefixed but suffixed with `dirty_token` (required).
  workgraph_dirty_events: "by_token",
  // Tenant-prefixed but suffixed with `id` (required). `by_tenant_id` is the
  // narrowest of several tenant-prefixed indexes on each, and any of them would
  // enumerate correctly; `by_tenant_id` is chosen because a per-row unique
  // suffix gives the scan a stable, total order.
  workgraph_agent_checkpoints: "by_tenant_id",
  workgraph_session_bindings: "by_tenant_id",
  // The quarantine table is owner-scoped ONLY — it holds rows whose
  // organization could not be resolved, which is the whole reason it exists, so
  // there is no `organization_id` to pin. Its range is deliberately one `eq`.
  workgraph_tenancy_migration_quarantine: "by_owner",
}

/** Rows in the quarantine table carry no resolvable organization. */
const OWNER_ONLY_DELETION_TABLES = new Set(["workgraph_tenancy_migration_quarantine"])

export function ownerDeletionIndex(table: string) {
  return WORKGRAPH_OWNER_DELETION_INDEXES[table] ?? "by_tenant"
}

async function deleteOwnerRecordBatch(ctx: any, organization: string, owner: string) {
  let remaining = WORKGRAPH_OWNER_DELETION_BATCH_SIZE
  let deleted = 0
  for (const table of WORKGRAPH_OWNER_TABLES) {
    if (remaining === 0) return { deleted, complete: false }
    const candidates = await ctx.db.query(table)
      .withIndex(
        ownerDeletionIndex(table),
        (query: any) => OWNER_ONLY_DELETION_TABLES.has(table)
          ? query.eq("owner_user_id", owner)
          : query.eq("organization_id", organization).eq("owner_user_id", owner),
      )
      .take(remaining + 1)
    const rows = candidates.slice(0, remaining)
    for (const row of rows) await ctx.db.delete(row._id)
    deleted += rows.length
    remaining -= rows.length
    if (candidates.length > rows.length) return { deleted, complete: false }
  }
  return { deleted, complete: true }
}

async function renewDeletion(ctx: any, barrier: any, receipt: any, now: number) {
  await ctx.db.patch(barrier._id, { lease_expires_at: now + deletionLeaseMs, updated_at: now })
  await ctx.db.patch(receipt._id, { lease_expires_at: now + deletionLeaseMs, updated_at: now })
}

/**
 * Quiescence reads, resolved through the same index map as the delete batch.
 *
 * All eight tables this is called with do declare `by_tenant`, so the resolver
 * is a no-op for them today — it is here so the two sites cannot drift apart. A
 * hardcoded `"by_tenant"` in one place and a map in the other is how the
 * original defect would come back: the delete path would be fixed for a new
 * table while the precondition read that guards it still threw.
 */
function ownerRows(ctx: any, table: string, organization: string, owner: string) {
  return ctx.db.query(table).withIndex(ownerDeletionIndex(table), (query: any) =>
    query.eq("organization_id", organization).eq("owner_user_id", owner),
  ).collect()
}

function ownerDeletionBarrier(ctx: any, organization: string, owner: string) {
  return ctx.db.query("workgraph_owner_deletion_barriers")
    .withIndex("by_tenant", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .unique()
}

function exactString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
