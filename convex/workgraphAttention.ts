import type { GenericMutationCtx } from "convex/server"
import type { DataModel } from "./_generated/dataModel"

type Ctx = GenericMutationCtx<DataModel>
type AttentionKind =
  | "admission_proposal"
  | "decision"
  | "work_item"
  | "attempt"
  | "recap_notification"
  | "unorganized_ai_work"
  | "configuration_required"
type CandidateAttentionProjection = "none" | "external_issue" | "session"

const maximumTimestamp = Number.MAX_SAFE_INTEGER
const attentionWorkItemStates = new Set(["result_ready", "blocked", "review_needed", "integration_needed", "verification_failed", "failed"])
const attentionJobStates = new Set(["pending", "failed", "failed_terminal", "attention"])

export function attentionPositionKey(position: Readonly<{ updatedAt: number; kind: string; id: string }>) {
  const timestamp = maximumTimestamp - position.updatedAt
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("Invalid Attention timestamp")
  return `${String(timestamp).padStart(16, "0")}:${position.kind}:${encodeURIComponent(position.id)}`
}

export async function initializeAttentionProjection(ctx: Ctx, owner: string, now: number) {
  const existing = await attentionSummary(ctx, owner)
  if (existing) return existing._id
  return ctx.db.insert("workgraph_attention_summaries", {
    owner_user_id: owner as never,
    total: 0,
    external_issue_count: 0,
    session_count: 0,
    projection_version: 2,
    updated_at: now,
  })
}

export async function syncAttentionRecord(ctx: Ctx, table: string, row: any) {
  if (table === "workgraph_admission_proposals") {
    return setAttentionEntry(ctx, row.owner_user_id, "admission_proposal", row.id, table, row.updated_at, row.state === "proposed")
  }
  if (table === "workgraph_decisions") {
    return setAttentionEntry(ctx, row.owner_user_id, "decision", row.id, table, row.updated_at, row.state === "proposed" || row.state === "pending")
  }
  if (table === "workgraph_work_items") {
    return setAttentionEntry(ctx, row.owner_user_id, "work_item", row.id, table, row.updated_at, attentionWorkItemStates.has(row.state))
  }
  if (table === "workgraph_attempts") {
    return setAttentionEntry(ctx, row.owner_user_id, "attempt", row.id, table, row.updated_at, row.state === "attention")
  }
  if (table === "workgraph_notifications") {
    return setAttentionEntry(ctx, row.owner_user_id, "recap_notification", row.id, table, row.updated_at, row.state === "unread")
  }
  if (table === "workgraph_connection_metadata") {
    return setAttentionEntry(ctx, row.owner_user_id, "configuration_required", row.connection_id, table, row.updated_at, row.status === "degraded" || row.status === "broken")
  }
  if (table === "workgraph_due_jobs") {
    const marker = row.payload?.configurationRequirement
    const active = attentionJobStates.has(row.status) && typeof row.last_error === "string" && Boolean(row.last_error.trim()) && marker?.type === "generation"
    return setAttentionEntry(ctx, row.owner_user_id, "configuration_required", row.id, table, row.updated_at, active)
  }
}

export async function removeAttentionRecord(ctx: Ctx, owner: string, table: string, id: string) {
  const identity = table === "workgraph_connection_metadata"
    ? { kind: "configuration_required" as const, id }
    : table === "workgraph_due_jobs"
      ? { kind: "configuration_required" as const, id }
      : table === "workgraph_admission_proposals"
        ? { kind: "admission_proposal" as const, id }
        : table === "workgraph_decisions"
          ? { kind: "decision" as const, id }
          : table === "workgraph_work_items"
            ? { kind: "work_item" as const, id }
            : table === "workgraph_attempts"
              ? { kind: "attempt" as const, id }
              : table === "workgraph_notifications"
                ? { kind: "recap_notification" as const, id }
                : undefined
  if (!identity) return
  await setAttentionEntry(ctx, owner, identity.kind, identity.id, table, 0, false)
}

export async function syncAttentionResource(ctx: Ctx, owner: string, table: string, id: string) {
  const index = table === "workgraph_connection_metadata" ? "by_owner_connection" : "by_owner_id"
  const row = await ctx.db.query(table as never).withIndex(index as never, (query: any) => {
    const range = query.eq("owner_user_id", owner)
    return table === "workgraph_connection_metadata" ? range.eq("connection_id", id) : range.eq("id", id)
  }).unique()
  if (row) return syncAttentionRecord(ctx, table, row)
  return removeAttentionRecord(ctx, owner, table, id)
}

export async function syncCandidateTransition(ctx: Ctx, before: any | undefined, after: any | undefined) {
  const owner = String(after?.owner_user_id ?? before?.owner_user_id ?? "")
  if (!owner) throw new Error("Candidate Attention transition requires an owner")
  const id = String(after?.id ?? before?.id ?? "")
  if (!id) throw new Error("Candidate Attention transition requires a candidate id")
  const candidate = await ctx.db.query("workgraph_intake_candidates")
    .withIndex("by_owner_id", (query) => query.eq("owner_user_id", owner as never).eq("id", id))
    .unique()
  if (!candidate) throw new Error(`Candidate Attention source ${id} is missing`)
  const summary = await requireCandidateAttentionSummary(ctx, owner, candidate.updated_at)
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
    .withIndex("by_owner_status_updated_id", (query) => query.eq("owner_user_id", owner as never).eq("status", "unorganized"))
    .order("desc")
    .take(1))[0]
  await setAttentionEntry(
    ctx,
    owner,
    "unorganized_ai_work",
    "unorganized_ai_work",
    "workgraph_intake_candidates",
    latest?.updated_at ?? now,
    externalIssueCount + sessionCount > 0,
  )
}

async function setAttentionEntry(
  ctx: Ctx,
  owner: string,
  kind: AttentionKind,
  id: string,
  sourceType: string,
  updatedAt: number,
  active: boolean,
) {
  const existing = await ctx.db.query("workgraph_attention_entries")
    .withIndex("by_owner_kind_id", (query) => query.eq("owner_user_id", owner as never).eq("kind", kind).eq("id", id))
    .unique()
  if (!active && !existing) return
  const summary = await requireAttentionSummary(ctx, owner)
  if (!active && existing) {
    if (summary.total < 1) throw new Error("Attention total underflow")
    await ctx.db.delete(existing._id)
    await ctx.db.patch(summary._id, { total: summary.total - 1, updated_at: Math.max(summary.updated_at, updatedAt) })
    return
  }
  const value = {
    source_type: sourceType,
    position_key: attentionPositionKey({ updatedAt, kind, id }),
    updated_at: updatedAt,
  }
  if (existing) {
    await ctx.db.patch(existing._id, value)
    return
  }
  await ctx.db.insert("workgraph_attention_entries", {
    owner_user_id: owner as never,
    kind,
    id,
    ...value,
  })
  await ctx.db.patch(summary._id, { total: summary.total + 1, updated_at: Math.max(summary.updated_at, updatedAt) })
}

function attentionSummary(ctx: Ctx, owner: string) {
  return ctx.db.query("workgraph_attention_summaries")
    .withIndex("by_owner", (query) => query.eq("owner_user_id", owner as never))
    .unique()
}

async function requireAttentionSummary(ctx: Ctx, owner: string) {
  const summary = await attentionSummary(ctx, owner)
  if (summary) return summary
  const now = Date.now()
  const value = {
    owner_user_id: owner as never,
    total: 0,
    external_issue_count: 0,
    session_count: 0,
    projection_version: 2,
    updated_at: now,
  } as const
  const id = await ctx.db.insert("workgraph_attention_summaries", value)
  return { _id: id, _creationTime: now, ...value }
}

async function requireCandidateAttentionSummary(ctx: Ctx, owner: string, now: number) {
  const summary = await requireAttentionSummary(ctx, owner)
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
