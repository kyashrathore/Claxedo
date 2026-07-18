import { v } from "convex/values"
import { serviceMutation } from "./model"
import { requireTrustedWorkGraphTenantSubject } from "./workgraphModel"

const deletionLeaseMs = 5 * 60 * 1_000
export const WORKGRAPH_OWNER_DELETION_BATCH_SIZE = 8

export const WORKGRAPH_OWNER_TABLES = [
  "workgraph_attention_entries",
  "workgraph_attention_summaries",
  "workgraph_attempt_connection_bindings",
  "workgraph_decision_work_items",
  "workgraph_evidence",
  "workgraph_durable_effect_receipts",
  "workgraph_record_source_revisions",
  "workgraph_work_item_dependencies",
  "workgraph_changes",
  "workgraph_events",
  "workgraph_outbox",
  "workgraph_due_jobs",
  "workgraph_cleanup_receipts",
  "workgraph_runtime_effects",
  "workgraph_leases",
  "workgraph_agent_checkpoints",
  "workgraph_session_bindings",
  "workgraph_attempts",
  "workgraph_decisions",
  "workgraph_work_items",
  "workgraph_outcomes",
  "workgraph_stream_sequences",
  "workgraph_streams",
  "workgraph_external_identities",
  "workgraph_admission_proposals",
  "workgraph_intake_candidates",
  "workgraph_source_views",
  "work_source_revisions",
  "work_sources",
  "workgraph_change_cursors",
  "workgraph_archive_restores",
  "workgraph_migration_intake",
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
  const [streams, attempts] = await Promise.all([
    ownerRows(ctx, "workgraph_streams", organization, owner),
    ownerRows(ctx, "workgraph_attempts", organization, owner),
  ])
  const streamIds: string[] = [...new Set<string>([
    ...streams.map((stream: any) => String(stream.id)),
    ...attempts.filter((attempt: any) => attempt.envelope_id).map((attempt: any) => String(attempt.stream_id)),
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
    attempts.filter((attempt: any) => attempt.stream_id === streamId).forEach((attempt: any) => {
      const value = exactString(attempt.envelope_id)
      if (value) envelopeIds.add(value)
    })
    if (envelopeIds.size === 0) return []
    if (envelopeIds.size !== 1) throw new Error("Stream has conflicting execution envelope identities")
    const childIsolationIds: string[] = [...new Set<string>(attempts
      .filter((attempt: any) => attempt.stream_id === streamId)
      .map((attempt: any) => exactString(attempt.child_workspace_id))
      .filter((value: string | undefined): value is string => value !== undefined))].sort()
    return [{ streamId, envelopeId: [...envelopeIds][0]!, childIsolationIds }]
  })
}

async function isQuiescent(ctx: any, organization: string, owner: string) {
  const [attempts, leases, runtimeEffects, bindings, proposals, outbox, jobs] = await Promise.all([
    ownerRows(ctx, "workgraph_attempts", organization, owner),
    ownerRows(ctx, "workgraph_leases", organization, owner),
    ownerRows(ctx, "workgraph_runtime_effects", organization, owner),
    ownerRows(ctx, "workgraph_attempt_connection_bindings", organization, owner),
    ownerRows(ctx, "workgraph_admission_proposals", organization, owner),
    ownerRows(ctx, "workgraph_outbox", organization, owner),
    ownerRows(ctx, "workgraph_due_jobs", organization, owner),
  ])
  return !attempts.some((row: any) => ["admitted", "placing", "running", "attention"].includes(row.state))
    && leases.length === 0
    && !runtimeEffects.some((row: any) => row.state !== "completed")
    && !bindings.some((row: any) => row.revoked_at === undefined)
    && !proposals.some((row: any) => row.state === "planning")
    && !outbox.some((row: any) => row.status !== "completed")
    && !jobs.some((row: any) => ["pending", "running", "claimed"].includes(row.status))
}

async function deleteOwnerRecordBatch(ctx: any, organization: string, owner: string) {
  let remaining = WORKGRAPH_OWNER_DELETION_BATCH_SIZE
  let deleted = 0
  for (const table of WORKGRAPH_OWNER_TABLES) {
    if (remaining === 0) return { deleted, complete: false }
    const candidates = await ctx.db.query(table)
      .withIndex("by_tenant", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
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

function ownerRows(ctx: any, table: string, organization: string, owner: string) {
  return ctx.db.query(table).withIndex("by_tenant", (query: any) =>
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
