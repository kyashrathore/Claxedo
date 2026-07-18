import type { GenericMutationCtx } from "convex/server"
import { v } from "convex/values"
import type { DataModel } from "./_generated/dataModel"
import { serviceMutation } from "./model"
import { assertWorkGraphOwnerWritable, requireTrustedWorkGraphTenantSubject } from "./workgraphModel"

type Ctx = GenericMutationCtx<DataModel>
type AttentionKind =
  | "admission_proposal"
  | "decision"
  | "work_item"
  | "attempt"
  | "unorganized_ai_work"
  | "configuration_required"
type CandidateAttentionProjection = "none" | "external_issue" | "session"

const maximumTimestamp = Number.MAX_SAFE_INTEGER
// `pending_approval` (Staged) surfaces in Needs-you so the owner can approve/reject
// agent-created tasks (plan §6). Approval moves the item to `pending`, which is not
// an attention state, so the entry clears on the same doorbell.
const attentionWorkItemStates = new Set(["pending_approval", "result_ready", "blocked", "review_needed", "integration_needed", "verification_failed", "failed"])
const attentionJobStates = new Set(["pending", "failed", "failed_terminal", "attention"])

export function attentionPositionKey(position: Readonly<{ updatedAt: number; kind: string; id: string }>) {
  const timestamp = maximumTimestamp - position.updatedAt
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid Attention timestamp")
  return `${String(timestamp).padStart(16, "0")}:${position.kind}:${encodeURIComponent(position.id)}`
}

export async function initializeAttentionProjection(ctx: Ctx, organization: string, owner: string, now: number) {
  const existing = await attentionSummary(ctx, organization, owner)
  if (existing) return existing._id
  return ctx.db.insert("workgraph_attention_summaries", {
    organization_id: organization as never,
    owner_user_id: owner as never,
    total: 0,
    visible_total: 0,
    external_issue_count: 0,
    session_count: 0,
    projection_version: 2,
    updated_at: now,
  })
}

export const acknowledgeForService = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), operation: v.any() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    await assertWorkGraphOwnerWritable(ctx, tenant.organization_id, tenant.owner_user_id)
    const operation = args.operation as { type?: unknown; now?: unknown }
    if (operation.type !== "mark_all_read" && operation.type !== "clear") {
      throw new Error("Unsupported Attention acknowledgement operation")
    }
    if (typeof operation.now !== "number" || !Number.isSafeInteger(operation.now) || operation.now < 0) {
      throw new Error("Invalid Attention acknowledgement timestamp")
    }
    const summary = await requireAttentionSummary(
      ctx,
      String(tenant.organization_id),
      String(tenant.owner_user_id),
    )
    const readAt = Math.max(summary.read_through_at ?? 0, operation.now)
    const clearedAt = operation.type === "clear"
      ? Math.max(summary.cleared_through_at ?? 0, operation.now)
      : summary.cleared_through_at
    await ctx.db.patch(summary._id, {
      read_through_at: readAt,
      ...(clearedAt === undefined ? {} : { cleared_through_at: clearedAt }),
      ...(operation.type === "clear" ? { visible_total: 0 } : {}),
    })
    return {
      ownerUserId: String(tenant.owner_user_id),
      readAt,
      ...(clearedAt === undefined ? {} : { clearedAt }),
    }
  },
})

export async function syncAttentionRecord(ctx: Ctx, table: string, row: any) {
  const organization = String(row.organization_id ?? "")
  if (!organization) throw new Error("Attention source requires a WorkGraph organization")
  if (table === "workgraph_admission_proposals") {
    return setAttentionEntry(ctx, organization, row.owner_user_id, "admission_proposal", row.id, table, row.updated_at, row.state === "proposed")
  }
  if (table === "workgraph_decisions") {
    return setAttentionEntry(ctx, organization, row.owner_user_id, "decision", row.id, table, row.updated_at, row.state === "proposed" || row.state === "pending")
  }
  if (table === "workgraph_work_items") {
    return setAttentionEntry(ctx, organization, row.owner_user_id, "work_item", row.id, table, row.updated_at, attentionWorkItemStates.has(row.state))
  }
  if (table === "workgraph_attempts") {
    return setAttentionEntry(ctx, organization, row.owner_user_id, "attempt", row.id, table, row.updated_at, row.state === "attention")
  }
  if (table === "workgraph_due_jobs") {
    const marker = row.payload?.configurationRequirement
    const active = attentionJobStates.has(row.status) && typeof row.last_error === "string" && Boolean(row.last_error.trim()) && marker?.type === "generation"
    return setAttentionEntry(ctx, organization, row.owner_user_id, "configuration_required", row.id, table, row.updated_at, active)
  }
}

export async function removeAttentionRecord(ctx: Ctx, organization: string, owner: string, table: string, id: string) {
  const identity = table === "workgraph_due_jobs"
      ? { kind: "configuration_required" as const, id }
      : table === "workgraph_admission_proposals"
        ? { kind: "admission_proposal" as const, id }
        : table === "workgraph_decisions"
          ? { kind: "decision" as const, id }
          : table === "workgraph_work_items"
            ? { kind: "work_item" as const, id }
            : table === "workgraph_attempts"
              ? { kind: "attempt" as const, id }
              : undefined
  if (!identity) return
  await setAttentionEntry(ctx, organization, owner, identity.kind, identity.id, table, 0, false)
}

export async function syncAttentionResource(ctx: Ctx, organization: string, owner: string, table: string, id: string) {
  const row = await ctx.db.query(table as never).withIndex("by_tenant" as never, (query: any) =>
    query.eq("organization_id", organization).eq("owner_user_id", owner),
  ).filter((query: any) => query.eq(query.field("id"), id)).unique()
  if (row) return syncAttentionRecord(ctx, table, row)
  return removeAttentionRecord(ctx, organization, owner, table, id)
}

export async function syncConnectionAttention(ctx: Ctx, organization: string, connectionId: string, status: string, updatedAt: number) {
  const memberships = await ctx.db.query("org_memberships")
    .withIndex("by_org_user", (query) => query.eq("org_id", organization as never))
    .collect()
  const views = (await Promise.all(memberships.map((membership) => ctx.db.query("workgraph_source_views")
    .withIndex("by_tenant_connection", (query) => query
      .eq("organization_id", organization as never)
      .eq("owner_user_id", membership.user_id)
      .eq("team_connection_id", connectionId))
    .collect()))).flat()
  await Promise.all([...new Set(views.map((view) => String(view.owner_user_id)))].map((owner) =>
    setAttentionEntry(ctx, organization, owner, "configuration_required", connectionId, "workgraph_connection_metadata", updatedAt, status === "degraded" || status === "broken"),
  ))
}

export async function syncCandidateTransition(ctx: Ctx, before: any | undefined, after: any | undefined) {
  const owner = String(after?.owner_user_id ?? before?.owner_user_id ?? "")
  if (!owner) throw new Error("Candidate Attention transition requires an owner")
  const organization = String(after?.organization_id ?? before?.organization_id ?? "")
  if (!organization) throw new Error("Candidate Attention transition requires an organization")
  const id = String(after?.id ?? before?.id ?? "")
  if (!id) throw new Error("Candidate Attention transition requires a candidate id")
  const candidate = await ctx.db.query("workgraph_intake_candidates")
    .withIndex("by_tenant", (query) => query.eq("organization_id", organization as never).eq("owner_user_id", owner as never))
    .filter((query) => query.eq(query.field("id"), id))
    .unique()
  if (!candidate) throw new Error(`Candidate Attention source ${id} is missing`)
  const summary = await requireCandidateAttentionSummary(ctx, organization, owner, candidate.updated_at)
  const projected = candidate.attention_projection as CandidateAttentionProjection | undefined
  const desired = candidate.status === "unorganized" ? candidate.candidate_kind : "none"
  const delta = (kind: Exclude<CandidateAttentionProjection, "none">) => Number(desired === kind) - Number(projected === kind)
  const externalIssueCount = summary.external_issue_count + delta("external_issue")
  const sessionCount = summary.session_count + delta("session")
  if (externalIssueCount < 0 || sessionCount < 0) throw new Error("Candidate Attention count underflow")
  const now = Number(candidate.updated_at)
  if (projected !== desired) await ctx.db.patch(candidate._id, { attention_projection: desired })
  await ctx.db.patch(summary._id, {
    external_issue_count: externalIssueCount,
    session_count: sessionCount,
    updated_at: Math.max(summary.updated_at, now),
  })
  const latest = (await ctx.db.query("workgraph_intake_candidates")
    .withIndex("by_tenant_status_updated_id", (query) => query.eq("organization_id", organization as never).eq("owner_user_id", owner as never).eq("status", "unorganized"))
    .order("desc")
    .take(1))[0]
  await setAttentionEntry(
    ctx,
    organization,
    owner,
    "unorganized_ai_work",
    "unorganized_ai_work",
    "workgraph_intake_candidates",
    Math.max(latest?.updated_at ?? 0, now),
    externalIssueCount + sessionCount > 0,
  )
}

async function setAttentionEntry(
  ctx: Ctx,
  organization: string,
  owner: string,
  kind: AttentionKind,
  id: string,
  sourceType: string,
  updatedAt: number,
  active: boolean,
) {
  const existing = await ctx.db.query("workgraph_attention_entries")
    .withIndex("by_tenant_kind_id", (query) => query.eq("organization_id", organization as never).eq("owner_user_id", owner as never).eq("kind", kind).eq("id", id))
    .unique()
  if (!active && !existing) return
  const summary = await requireAttentionSummary(ctx, organization, owner)
  const visibleTotal = summary.visible_total ?? summary.total
  const wasVisible = existing ? summary.cleared_through_at === undefined || existing.updated_at > summary.cleared_through_at : false
  const isVisible = summary.cleared_through_at === undefined || updatedAt > summary.cleared_through_at
  if (!active && existing) {
    if (summary.total < 1) throw new Error("Attention total underflow")
    await ctx.db.delete(existing._id)
    await ctx.db.patch(summary._id, {
      total: summary.total - 1,
      visible_total: visibleTotal - Number(wasVisible),
      updated_at: Math.max(summary.updated_at, updatedAt),
    })
    return
  }
  const value = {
    source_type: sourceType,
    position_key: attentionPositionKey({ updatedAt, kind, id }),
    updated_at: updatedAt,
  }
  if (existing) {
    await ctx.db.patch(existing._id, value)
    await ctx.db.patch(summary._id, {
      visible_total: visibleTotal + Number(isVisible) - Number(wasVisible),
      updated_at: Math.max(summary.updated_at, updatedAt),
    })
    return
  }
  await ctx.db.insert("workgraph_attention_entries", {
    organization_id: organization as never,
    owner_user_id: owner as never,
    kind,
    id,
    ...value,
  })
  await ctx.db.patch(summary._id, {
    total: summary.total + 1,
    visible_total: visibleTotal + Number(isVisible),
    updated_at: Math.max(summary.updated_at, updatedAt),
  })
}

function attentionSummary(ctx: Ctx, organization: string, owner: string) {
  return ctx.db.query("workgraph_attention_summaries")
    .withIndex("by_tenant", (query) => query.eq("organization_id", organization as never).eq("owner_user_id", owner as never))
    .unique()
}

async function requireAttentionSummary(ctx: Ctx, organization: string, owner: string) {
  const summary = await attentionSummary(ctx, organization, owner)
  if (summary) return summary
  const now = Date.now()
  const value = {
    organization_id: organization as never,
    owner_user_id: owner as never,
    total: 0,
    visible_total: 0,
    external_issue_count: 0,
    session_count: 0,
    projection_version: 2,
    updated_at: now,
  } as const
  const id = await ctx.db.insert("workgraph_attention_summaries", value)
  return { _id: id, _creationTime: now, ...value }
}

async function requireCandidateAttentionSummary(ctx: Ctx, organization: string, owner: string, now: number) {
  const summary = await requireAttentionSummary(ctx, organization, owner)
  if (summary.projection_version === 2) return summary
  const upgraded = {
    ...summary,
    external_issue_count: 0,
    session_count: 0,
    projection_version: 2 as const,
    updated_at: Math.max(summary.updated_at, now),
  }
  await ctx.db.patch(summary._id, {
    external_issue_count: upgraded.external_issue_count,
    session_count: upgraded.session_count,
    projection_version: upgraded.projection_version,
    updated_at: upgraded.updated_at,
  })
  return upgraded
}
