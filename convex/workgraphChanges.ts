import { evaluateCompletionContract } from "@claxedo/workgraph/domain"
import { AdmissionProposalDtoSchema, RunDetailDtoSchema, AttentionCursorError, AttentionItemSchema, AttentionPageSchema, ChangeCursorError, EvidenceDtoSchema, EvidencePageCursorError, EvidencePageSchema, ReplacementReviewSchema, SnapshotResumeCursorError, TaskActivityPageCursorError, WorkItemRunPageCursorError, WorkItemRunPageSchema, compareEvidenceCursorPosition, compareSnapshotCursorPosition, compareWorkItemRunPosition, createAttentionCursor, createChangeCursor, createEvidencePageCursor, createSnapshotResumeCursor, createWorkItemRunPageCursor, decodeSnapshotResumeCursor, readAttentionCursor, readChangeCursor, readEvidencePageCursor, readWorkItemRunPageCursor, type EvidenceSubject } from "@claxedo/workgraph/contracts"
import { ConvexError, v } from "convex/values"
import type { GenericQueryCtx } from "convex/server"
import { authedQuery, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, requireOwnedWorkGraphContext, requireTrustedWorkGraphTenantSubject } from "./workgraphModel"
import { attentionPositionKey } from "./workgraphAttention"
import { readTaskActivityProjection } from "./workgraphActivity"
import type { DataModel, Id } from "./_generated/dataModel"

const MAX_PAGE = 100
const evidenceSubject = v.union(
  v.object({ type: v.literal("stream"), streamId: v.string() }),
  v.object({ type: v.literal("outcome"), outcomeId: v.string() }),
  v.object({ type: v.literal("work_item"), workItemId: v.string() }),
)
const query = v.union(
  v.object({ kind: v.literal("defaults") }),
  v.object({ kind: v.literal("snapshot"), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("attention"), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("stream"), streamId: v.string() }),
  v.object({ kind: v.literal("sources"), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("source"), workSourceId: v.string() }),
  v.object({ kind: v.literal("source_revision"), workSourceId: v.string(), revisionId: v.string() }),
  v.object({
    kind: v.literal("changes"),
    limit: v.number(),
    after: v.optional(v.string()),
    deliveredEventIds: v.optional(v.array(v.string())),
  }),
  v.object({ kind: v.literal("stream_changes"), streamId: v.string(), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("work_item"), workItemId: v.string() }),
  v.object({ kind: v.literal("work_item_detail"), workItemId: v.string() }),
  v.object({ kind: v.literal("work_item_runs"), workItemId: v.string(), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("work_item_activity"), workItemId: v.string(), granularity: v.union(v.literal("milestones"), v.literal("progress"), v.literal("detailed")), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("admission_proposal"), proposalId: v.string() }),
  v.object({ kind: v.literal("replacement_review"), streamId: v.string(), previousSource: v.object({ workSourceId: v.string(), revisionId: v.string(), contentHash: v.string() }) }),
  v.object({ kind: v.literal("run"), runId: v.string() }),
  v.object({ kind: v.literal("decision"), decisionId: v.string() }),
  v.object({ kind: v.literal("evidence"), evidenceId: v.string() }),
  v.object({ kind: v.literal("evidence_list"), subject: evidenceSubject, limit: v.number(), after: v.optional(v.string()) }),
)
const ownerQueryArgs = { organization_id: v.id("orgs"), query }

export const read = authedQuery({
  args: ownerQueryArgs,
  handler: async (ctx, args) => {
    const owned = await requireOwnedWorkGraphContext(ctx)
    const membership = await ctx.db.query("org_memberships")
      .withIndex("by_org_user", (query: any) => query.eq("org_id", args.organization_id).eq("user_id", owned.owner_user_id)).unique()
    if (!membership) throw new Error("WorkGraph organization membership is required")
    return readWorkGraphProjection(ctx, String(args.organization_id), String(owned.owner_user_id), args.query.kind, args.query)
  },
})

export const readForService = serviceQuery({
  args: { ...ownerQueryArgs, owner_subject: v.string() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return readWorkGraphProjection(ctx, String(tenant.organization_id), String(tenant.owner_user_id), args.query.kind, args.query)
  },
})

/** Shared projection implementation keeps interactive and service reads identical. */
export async function readWorkGraphProjection(ctx: any, organization: string, owner: string, kind: string, input: Record<string, any>) {
  await assertWorkGraphOwnerReadable(ctx, organization, owner)
  if (kind === "defaults") return defaultsDto(await owned(ctx, "workgraphs", organization, owner, "workgraph_default"), owner)
  if (kind === "stream") {
    const stream = await owned(ctx, "workgraph_streams", organization, owner, requireText(input.streamId, "streamId"))
    return stream ? streamDto(stream, owner) : null
  }
  if (kind === "source_revision") {
    const revision = await owned(ctx, "work_source_revisions", organization, owner, requireText(input.revisionId, "revisionId"))
    if (!revision || revision.work_source_id !== requireText(input.workSourceId, "workSourceId")) return null
    return {
      id: revision.id, workSourceId: revision.work_source_id, revisionNumber: revision.revision_number,
      content: revision.content, contentHash: revision.content_hash, origin: revision.origin,
      createdAt: revision.created_at, createdBy: revision.created_by,
    }
  }
  if (kind === "source") {
    const source = await owned(ctx, "work_sources", organization, owner, requireText(input.workSourceId, "workSourceId"))
    return source ? sourceDto(source, owner) : null
  }
  if (kind === "sources") {
    const limit = requireLimit(input.limit)
    const cursor = input.after === undefined ? null : readTenantCursor(input.after, "work_sources", organization, owner)
    const result = await ctx.db.query("work_sources").withIndex("by_tenant", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
      .paginate({ cursor, numItems: limit })
    return {
      sources: result.page.map((row: any) => sourceDto(row, owner)),
      hasMore: !result.isDone,
      ...(!result.isDone ? { nextCursor: createTenantCursor("work_sources", organization, owner, result.continueCursor) } : {}),
    }
  }
  if (kind === "work_item") {
    const item = await owned(ctx, "workgraph_work_items", organization, owner, requireText(input.workItemId, "workItemId"))
    if (!item) return null
    const evidence = await ctx.db.query("workgraph_evidence")
      .withIndex("by_tenant_subject", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("subject_type", "work_item").eq("subject_id", item.id))
      .filter((q: any) => q.eq(q.field("organization_id"), organization)).collect()
    const subject = { type: "work_item" as const, workItemId: item.id }
    const normalized = evidence.map((row: any) => ({
      ...row.reference, id: row.id, subject, recordedAt: row.created_at, recordedBy: row.provenance.actor,
    }))
    return { ...await workItemDto(ctx, organization, item, owner), completionSatisfied: evaluateCompletionContract(item.completion_contract, subject as any, normalized as any).satisfied }
  }
  if (kind === "work_item_detail") {
    const item = await owned(ctx, "workgraph_work_items", organization, owner, requireText(input.workItemId, "workItemId"))
    return item ? workItemDto(ctx, organization, item, owner) : null
  }
  if (kind === "work_item_runs") {
    try {
      return await workItemRunsPage(ctx, organization, owner, input)
    } catch (error) {
      if (error instanceof WorkItemRunPageCursorError) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "work_item_activity") {
    try {
      return await readTaskActivityProjection(ctx, organization, owner, input)
    } catch (error) {
      if (error instanceof TaskActivityPageCursorError) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "admission_proposal") {
    const proposal = await owned(ctx, "workgraph_admission_proposals", organization, owner, requireText(input.proposalId, "proposalId"))
    return proposal ? admissionDto(proposal, owner) : null
  }
  if (kind === "replacement_review") return replacementReview(ctx, organization, owner, input)
  if (kind === "run") {
    const run = await owned(ctx, "workgraph_runs", organization, owner, requireText(input.runId, "runId"))
    return run ? runDetailDto(run, owner) : null
  }
  if (kind === "decision") {
    const decision = await owned(ctx, "workgraph_decisions", organization, owner, requireText(input.decisionId, "decisionId"))
    return decision ? decisionDto(ctx, organization, decision, owner) : null
  }
  if (kind === "evidence") {
    const evidence = await owned(ctx, "workgraph_evidence", organization, owner, requireText(input.evidenceId, "evidenceId"))
    return evidence ? evidenceDto(ctx, organization, evidence, owner) : null
  }
  if (kind === "evidence_list") {
    try {
      return await evidencePage(ctx, organization, owner, requireEvidenceSubject(input.subject), input)
    } catch (error) {
      if (isEvidencePageCursorError(error)) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "attention") {
    try {
      return await attentionPage(ctx, organization, owner, input)
    } catch (error) {
      if (error instanceof AttentionCursorError) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "snapshot") {
    try {
      return await snapshot(ctx, organization, owner, input)
    } catch (error) {
      if (error instanceof SnapshotResumeCursorError || snapshotCursorError(error)) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  try {
    return await changes(ctx, organization, owner, kind, input)
  } catch (error) {
    if (error instanceof ChangeCursorError) {
      throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
    }
    throw error
  }
}

async function replacementReview(ctx: any, organization: string, owner: string, input: Record<string, any>) {
  const streamId = requireText(input.streamId, "streamId")
  const previousSource = input.previousSource as { workSourceId?: unknown; revisionId?: unknown; contentHash?: unknown } | undefined
  const workSourceId = requireText(previousSource?.workSourceId, "previousSource.workSourceId")
  const revisionId = requireText(previousSource?.revisionId, "previousSource.revisionId")
  const contentHash = requireText(previousSource?.contentHash, "previousSource.contentHash")
  const [stream, revision] = await Promise.all([
    owned(ctx, "workgraph_streams", organization, owner, streamId),
    owned(ctx, "work_source_revisions", organization, owner, revisionId),
  ])
  if (!stream || !revision || revision.work_source_id !== workSourceId || revision.content_hash !== contentHash) return undefined
  const base = { streamId, streamTitle: stream.title }
  if (stream.replacement_reset && stream.replacement_reset.state !== "completed") {
    return ReplacementReviewSchema.parse({ ...base, status: "unavailable", reason: "Stream replacement cleanup is still pending" })
  }
  const receipts = await ctx.db.query("workgraph_durable_effect_receipts")
    .withIndex("by_tenant_stream", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner).eq("stream_id", streamId))
    .take(1)
  if (receipts.length) {
    return ReplacementReviewSchema.parse({ ...base, status: "durable", reason: "Durable effects cannot be replaced" })
  }
  const current = (await ctx.db.query("workgraph_work_items")
    .withIndex("by_tenant_stream", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner).eq("stream_id", streamId))
    .collect())
    .filter((item: any) => item.state !== "completed" && item.state !== "abandoned")
    .sort((left: any, right: any) => String(left.id).localeCompare(String(right.id)))
  if (current.some((item: any) => !item.source_revision_refs.some((source: any) =>
    source.work_source_id === workSourceId && source.revision_id === revisionId && source.content_hash === contentHash))) {
    return ReplacementReviewSchema.parse({ ...base, status: "unrelated", reason: "Stream contains unrelated nonterminal work; keep or fork instead" })
  }
  if (!current.length) {
    return ReplacementReviewSchema.parse({ ...base, status: "empty", reason: "No source-linked Tasks remain to replace" })
  }
  return ReplacementReviewSchema.parse({
    ...base,
    status: "eligible",
    targets: current.map((item: any) => ({
      workItemId: item.id,
      expectedVersion: item.row_version,
      title: item.title,
      state: item.state,
    })),
  })
}

function createTenantCursor(kind: string, organization: string, owner: string, cursor: string) {
  return ["wgt1", kind, organization, owner, cursor].map(encodeURIComponent).join(":")
}

function readTenantCursor(value: unknown, kind: string, organization: string, owner: string) {
  if (typeof value !== "string") throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  const parts = decodeTenantCursor(value)
  if (parts.length !== 5 || parts[0] !== "wgt1" || !parts[4]) throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  if (parts[2] !== organization || parts[3] !== owner) throw new ConvexError({ code: "cursor_invalid", reason: "owner_mismatch" })
  if (parts[1] !== kind) throw new ConvexError({ code: "cursor_invalid", reason: "filter_mismatch" })
  return parts[4]
}

function decodeTenantCursor(value: string) {
  try {
    return value.split(":").map((part) => decodeURIComponent(part))
  } catch {
    throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  }
}

async function workItemRunsPage(ctx: any, organization: string, owner: string, input: Record<string, any>) {
  const workItemId = requireText(input.workItemId, "workItemId")
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readWorkItemRunPageCursor(input.after, organization, owner, workItemId)
  const rows = await ctx.db.query("workgraph_runs").withIndex("by_tenant_item_run", (q: any) => {
    const range = q.eq("organization_id", organization).eq("owner_user_id", owner).eq("work_item_id", workItemId)
    return resume ? range.gt("run_number", resume.runNumber) : range
  }).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit + 1)
  const ordered = rows
    .filter((row: any) => !resume || compareWorkItemRunPosition(
      { runNumber: row.run_number, id: row.id },
      { runNumber: resume.runNumber, id: resume.runId },
    ) > 0)
    .sort((left: any, right: any) => compareWorkItemRunPosition(
      { runNumber: left.run_number, id: left.id },
      { runNumber: right.run_number, id: right.id },
    ))
  const page = ordered.slice(0, limit)
  const hasMore = ordered.length > limit
  return WorkItemRunPageSchema.parse({
    runs: page.map((row: any) => runDetailDto(row, owner)),
    hasMore,
    ...(hasMore ? {
      nextCursor: createWorkItemRunPageCursor({
        organizationId: organization,
        ownerUserId: owner,
        workItemId,
        runNumber: page.at(-1)!.run_number,
        runId: page.at(-1)!.id,
      }),
    } : {}),
  })
}

async function attentionPage(ctx: any, organization: string, owner: string, input: Record<string, any>) {
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readAttentionCursor(input.after, organization, owner)
  const summary = await ctx.db.query("workgraph_attention_summaries").withIndex("by_tenant", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner)).unique()
  const source = ctx.db.query("workgraph_attention_entries").withIndex("by_tenant_position", (query: any) => {
      const range = query.eq("organization_id", organization).eq("owner_user_id", owner)
      return resume ? range.gt("position_key", attentionPositionKey(resume)) : range
    })
  const rows = await (summary?.cleared_through_at === undefined
    ? source
    : source.filter((query: any) => query.gt(query.field("updated_at"), summary.cleared_through_at)))
    .take(limit + 1)
  if (!summary) {
    const root = await owned(ctx, "workgraphs", organization, owner, "workgraph_default")
    if (root) throw new Error("Attention projection is not initialized for this owner")
  }
  const built = (await Promise.all(rows.slice(0, limit).map((row: any) => attentionProjectionItem(ctx, organization, owner, row, summary))))
    .filter((item: any) => item !== undefined)
  // Items scoped to a deletion-pending Stream no longer need the owner — the
  // deletion request already resolved them from the owner's point of view.
  const deleting = await deletionPendingStreamIds(ctx, organization, owner)
  const page = deleting.size === 0 ? built : built.filter((item: any) => {
    const streamId = item?.record?.streamId
    return !streamId || !deleting.has(streamId)
  })
  const hasMore = rows.length > limit
  return AttentionPageSchema.parse({
    items: page,
    total: summary ? summary.visible_total ?? summary.total : 0,
    hasMore,
    ...(hasMore && page.length ? { nextCursor: createAttentionCursor(organization, owner, page.at(-1)!) } : {}),
  })
}

async function attentionProjectionItem(ctx: any, organization: string, owner: string, entry: any, summary: any) {
  const read = summary?.read_through_at !== undefined && entry.updated_at <= summary.read_through_at
    ? { readAt: summary.read_through_at }
    : {}
  if (entry.kind === "unorganized_ai_work") {
    const counts = { externalIssues: summary.external_issue_count, sessions: summary.session_count, total: summary.external_issue_count + summary.session_count }
    return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read, counts })
  }
  if (entry.kind === "configuration_required") {
    if (entry.source_type === "workgraph_connection_metadata") {
      const row = await ctx.db.query("workgraph_connection_metadata").withIndex("by_organization_connection", (query: any) => query.eq("organization_id", organization).eq("connection_id", entry.id)).unique()
      if (!row) throw new Error(`Attention source ${entry.kind}:${entry.id} disappeared during its owner-scoped read`)
      return AttentionItemSchema.parse({
        kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read,
        requirement: { type: "connection", connectionId: row.connection_id, integrationId: row.integration_id, status: row.status, ...(row.account_label === undefined ? {} : { accountLabel: row.account_label }) },
      })
    }
    const row = await owned(ctx, "workgraph_due_jobs", organization, owner, entry.id)
    const marker = row?.payload?.configurationRequirement
    // Retired recap-era generation requirements survive in deployed due-job
    // rows (the contract narrowed `purpose` to "source_planning"). Like a
    // resolved-in-flight escalation, a retired purpose is a stale entry, not
    // a projection fault: skip it rather than failing the whole page.
    if (marker?.type === "generation" && marker.purpose !== "source_planning") return undefined
    if (!row || marker?.type !== "generation" || typeof row.last_error !== "string" || !row.last_error.trim()) throw new Error(`Attention source ${entry.kind}:${entry.id} is not a generation requirement`)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read,
      ...(marker.scope?.type === "stream"
        ? await attentionStreamPath(ctx, organization, owner, marker.scope.streamId)
        : {}),
      requirement: { type: "generation", jobId: row.id, purpose: marker.purpose, scope: marker.scope, reason: row.last_error },
    })
  }
  if (entry.kind === "master_escalation") {
    const row = await owned(ctx, "workgraph_streams", organization, owner, entry.id)
    const status = row?.master_status
    if (!row || status?.state !== "attention") {
      // A resolved-in-flight escalation is a stale entry, not a projection
      // fault: skip it rather than failing the whole attention page.
      return undefined
    }
    return AttentionItemSchema.parse({
      kind: entry.kind,
      ownerUserId: owner,
      id: entry.id,
      updatedAt: entry.updated_at,
      ...read,
      streamId: row.id,
      ...await attentionStreamPath(ctx, organization, owner, row.id),
      ...(typeof status.sessionId === "string" ? { sessionId: status.sessionId } : {}),
      ...(status.escalation === "public_pr_confirmation" || status.escalation === "failure_halt" ||
      status.escalation === "budget_exhausted"
        ? { category: status.escalation }
        : {}),
      reason: status.message,
      evidenceIds: [],
      receiptRefs: status.receiptRefs ?? [],
    })
  }
  const table = entry.source_type
  const row = await owned(ctx, table, organization, owner, entry.id)
  if (!row) throw new Error(`Attention source ${entry.kind}:${entry.id} disappeared during its owner-scoped read`)
  if (entry.kind === "admission_proposal") {
    const record = admissionDto(row, owner)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read, record,
      ...("suggestedPlacement" in record && record.suggestedPlacement.mode === "existing"
        ? await attentionStreamPath(ctx, organization, owner, record.suggestedPlacement.streamId)
        : {}),
    })
  }
  if (entry.kind === "decision") {
    const record = await decisionDto(ctx, organization, row, owner)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read, record,
      ...await attentionStreamPath(ctx, organization, owner, record.streamId),
    })
  }
  if (entry.kind === "work_item") {
    const record = await workItemDto(ctx, organization, row, owner)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read, record,
      ...await attentionStreamPath(ctx, organization, owner, record.streamId),
    })
  }
  if (entry.kind === "run") {
    const record = runDto(row, owner)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, ...read, record,
      ...await attentionStreamPath(ctx, organization, owner, record.streamId),
    })
  }
  throw new Error(`Unsupported Attention projection kind ${String(entry.kind)}`)
}

async function attentionStreamPath(ctx: any, organization: string, owner: string, streamId: string) {
  const path: Array<{ streamId: string; title: string }> = []
  const visited = new Set<string>()
  let current: string | undefined = streamId
  while (current) {
    if (visited.has(current) || path.length >= 100) throw new Error("Attention Stream ancestry is cyclic or too deep")
    visited.add(current)
    const stream = await owned(ctx, "workgraph_streams", organization, owner, current)
    if (!stream) throw new Error(`Attention Stream ${current} is missing`)
    path.unshift({ streamId: stream.id, title: stream.title })
    current = stream.parent_stream_id
  }
  return path.length > 1 ? { streamPath: path } : {}
}

async function evidencePage(ctx: any, organization: string, owner: string, subject: EvidenceSubject, input: Record<string, any>) {
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readEvidencePageCursor(input.after, organization, owner, subject)
  const subjectId = evidenceSubjectId(subject)
  const query = () => ctx.db.query("workgraph_evidence")
  const rows = (resume ? [
    ...await query().withIndex("by_tenant_subject_created_id", (q: any) =>
      q.eq("organization_id", organization).eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
        .eq("created_at", resume.recordedAt).gt("id", resume.evidenceId)
    ).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit + 1),
    ...await query().withIndex("by_tenant_subject_created_id", (q: any) =>
      q.eq("organization_id", organization).eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
        .gt("created_at", resume.recordedAt)
    ).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit + 1),
  ] : await query().withIndex("by_tenant_subject_created_id", (q: any) =>
    q.eq("organization_id", organization).eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
  ).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit + 1))
    .sort((left: any, right: any) => compareEvidenceCursorPosition(
      { recordedAt: left.created_at, id: left.id },
      { recordedAt: right.created_at, id: right.id },
    ))
    .slice(0, limit + 1)
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return EvidencePageSchema.parse({
    evidence: await Promise.all(page.map((row: any) => evidenceDto(ctx, organization, row, owner))),
    hasMore,
    ...(hasMore ? {
      nextCursor: createEvidencePageCursor({
        organizationId: organization,
        ownerUserId: owner,
        subject,
        recordedAt: page.at(-1)!.created_at,
        evidenceId: page.at(-1)!.id,
      }),
    } : {}),
  })
}

async function evidenceDto(ctx: any, organization: string, row: any, owner: string) {
  const evidence = {
    // `summary` is a required DTO field and lives in its own column on every
    // evidence row. Most writers ALSO spread it into `reference`, but the
    // connection pull-request writer (workgraphConnections.persistPullRequest
    // Receipt) does not — reading the column makes the projection correct for
    // every writer instead of depending on each one to duplicate it.
    summary: row.summary,
    ...row.reference,
    id: row.id,
    subject: evidenceSubjectFromRow(row),
    recordedAt: row.created_at,
    recordedBy: row.provenance.actor,
  }
  if (evidence.kind !== "integration" || evidence.effect === "other" || evidence.durableEffectReceiptId) {
    return EvidenceDtoSchema.parse(evidence)
  }
  const operationId = row.provenance?.operationId
  const receipt = typeof operationId === "string"
    ? await ctx.db.query("workgraph_durable_effect_receipts")
      .withIndex("by_tenant_idempotency", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("idempotency_key", `${operationId}:integration`))
      .filter((query: any) => query.eq(query.field("organization_id"), organization))
      .unique()
    : undefined
  return EvidenceDtoSchema.parse({
    ...evidence,
    ...(receipt ? { durableEffectReceiptId: receipt.id } : {}),
  })
}

function evidenceSubjectFromRow(row: any): EvidenceSubject {
  if (row.subject_type === "stream") return { type: "stream", streamId: row.subject_id }
  if (row.subject_type === "outcome") return { type: "outcome", outcomeId: row.subject_id }
  if (row.subject_type === "work_item") return { type: "work_item", workItemId: row.subject_id }
  throw new Error(`Unsupported Evidence subject type ${String(row.subject_type)}`)
}

function requireEvidenceSubject(value: unknown): EvidenceSubject {
  if (!value || typeof value !== "object" || !("type" in value)) throw new Error("Invalid Evidence subject")
  if (value.type === "stream" && "streamId" in value) return { type: "stream", streamId: requireText(value.streamId, "streamId") as never }
  if (value.type === "outcome" && "outcomeId" in value) return { type: "outcome", outcomeId: requireText(value.outcomeId, "outcomeId") as never }
  if (value.type === "work_item" && "workItemId" in value) return { type: "work_item", workItemId: requireText(value.workItemId, "workItemId") as never }
  throw new Error("Invalid Evidence subject")
}

function evidenceSubjectId(subject: EvidenceSubject) {
  if (subject.type === "stream") return subject.streamId
  if (subject.type === "outcome") return subject.outcomeId
  return subject.workItemId
}

function isEvidencePageCursorError(error: unknown): error is EvidencePageCursorError {
  return error instanceof Error && error.name === "EvidencePageCursorError" && "reason" in error &&
    ["invalid", "owner_mismatch", "subject_mismatch"].includes(String(error.reason))
}

function snapshotCursorError(error: unknown): error is Readonly<{
  code: "cursor_invalid"
  reason: "invalid" | "owner_mismatch" | "invalidated"
}> {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "cursor_invalid" || !("reason" in error)) return false
  return error.reason === "invalid" || error.reason === "owner_mismatch" || error.reason === "invalidated"
}

async function snapshot(
  ctx: GenericQueryCtx<DataModel>,
  organization: string,
  owner: string,
  input: Record<string, any>,
) {
  const organizationId = organization as Id<"orgs">
  const ownerUserId = owner as Id<"users">
  const limit = requireLimit(input.limit)
  const capturedAt = Date.now()
  const resume = input.after === undefined
    ? { offset: 0, capturedAt, position: undefined }
    : decodeSnapshotResumeCursor(input.after, organization, owner)
  if ("snapshotCursor" in resume) {
    const relevant = await ctx.db.query("workgraph_changes")
      .withIndex("by_tenant", (query) => query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .gt("_creationTime", readChangeCursor(resume.snapshotCursor, organization, owner)))
      .filter((query) => query.eq(query.field("snapshot_relevant"), true))
      .first()
    if (relevant) throw new SnapshotResumeCursorError("invalidated")
  }
  const snapshotCursor = "snapshotCursor" in resume
    ? resume.snapshotCursor
    : createChangeCursor({
        organizationId: organization,
        ownerUserId: owner,
        position: (await ctx.db.query("workgraph_changes")
          .withIndex("by_tenant", (query) => query
            .eq("organization_id", organizationId)
            .eq("owner_user_id", ownerUserId))
          .order("desc")
          .first())?._creationTime ?? 0,
      })
  const specs = [
    { table: "workgraph_streams", recordType: "stream", dto: (row: any) => streamDto(row, owner) },
    { table: "workgraph_outcomes", recordType: "outcome", dto: (row: any) => outcomeDto(row, owner) },
    { table: "workgraph_work_items", recordType: "work_item", dto: (row: any) => workItemDto(ctx, organization, row, owner) },
    { table: "workgraph_runs", recordType: "run", dto: (row: any) => runDto(row, owner) },
    { table: "workgraph_decisions", recordType: "decision", dto: (row: any) => decisionDto(ctx, organization, row, owner) },
    { table: "workgraph_admission_proposals", recordType: "admission_proposal", dto: (row: any) => admissionDto(row, owner) },
  ]
  // A deletion-pending Stream is already gone from the owner's point of view —
  // the durable teardown is background compensation. Hide it and every record
  // it scopes from the snapshot; the single-Stream read stays visible so
  // finalization checks (smoke cleanup verification) keep their strict meaning.
  const deleting = await deletionPendingStreamIds(ctx, organization, owner)
  // The deletion-pending filter runs AFTER take(): without padding, a small
  // page can be consumed ENTIRELY by rows the filter then drops, reporting
  // hasMore:false with no resume cursor while live records exist past them
  // (seen on staging: two stuck deletion-pending Streams at the head made
  // snapshot?limit=1 cursor-less). `deleting` is bounded by
  // DELETION_PENDING_SCAN_LIMIT, so the padded take stays bounded too.
  const takeLimit = limit + 1 + deleting.size
  const [root, ...batches] = await Promise.all([
    owned(ctx, "workgraphs", organization, owner, "workgraph_default"),
    ...specs.map(async (spec) => Promise.all(
      (await snapshotRows(ctx, organization, owner, spec.table, spec.recordType, resume.position, takeLimit))
        .filter((row: any) => spec.recordType !== "admission_proposal" || row.source)
        .filter((row: any) => !deleting.has(spec.recordType === "stream" ? row.id : row.stream_id))
        .map(spec.dto),
    )),
  ])
  const records = [defaultsDto(root, owner), ...batches.flat()]
    .filter((record: any) => !resume.position || compareSnapshotCursorPosition(record, resume.position) > 0)
    .sort(compareSnapshotCursorPosition)
  const page = records.slice(0, limit)
  const hasMore = records.length > limit
  return {
    snapshotCursor, records: page,
    references: page.map((record: any, index: number) => ({ sequence: resume.offset + index + 1, resource: { type: record.recordType, id: record.id }, version: record.version })),
    hasMore,
    ...(hasMore ? {
      nextCursor: createSnapshotResumeCursor({
        organizationId: organization,
        ownerUserId: owner,
        snapshotCursor,
        offset: resume.offset + page.length,
        capturedAt: resume.capturedAt,
        position: page.at(-1)!,
      }),
    } : {}), capturedAt: resume.capturedAt,
  }
}

// Deletion-pending Streams are transient (a durable teardown is compensating in
// the background), so the owner never has more than a handful at once. Bound the
// scan rather than collect() so the owner-bounded Attention/snapshot projections
// keep their no-unbounded-read guarantee (live-sync boundedness invariant).
const DELETION_PENDING_SCAN_LIMIT = 1024

async function deletionPendingStreamIds(ctx: any, organization: string, owner: string) {
  const rows = await ctx.db.query("workgraph_streams")
    .withIndex("by_tenant_created_id", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query: any) => query.neq(query.field("deletion"), undefined))
    .take(DELETION_PENDING_SCAN_LIMIT)
  return new Set<string>(rows.map((row: any) => row.id))
}

async function snapshotRows(
  ctx: any,
  organization: string,
  owner: string,
  table: string,
  recordType: string,
  position: Readonly<{ createdAt: number; recordType: string; id: string }> | undefined,
  limit: number,
) {
  const query = () => ctx.db.query(table)
  if (!position) {
    return query().withIndex("by_tenant_created_id", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
      .filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit)
  }
  const sameTimestamp = recordType.localeCompare(position.recordType) < 0
    ? []
    : await query().withIndex("by_tenant_created_id", (q: any) => {
      const range = q.eq("organization_id", organization).eq("owner_user_id", owner).eq("created_at", position.createdAt)
      return recordType === position.recordType ? range.gt("id", position.id) : range
    }).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit)
  const later = await query().withIndex("by_tenant_created_id", (q: any) =>
    q.eq("organization_id", organization).eq("owner_user_id", owner).gt("created_at", position.createdAt)
  ).filter((q: any) => q.eq(q.field("organization_id"), organization)).take(limit)
  return [...sameTimestamp, ...later]
    .sort((left, right) => left.created_at - right.created_at || String(left.id).localeCompare(String(right.id)))
    .slice(0, limit)
}

function defaultsDto(row: any, owner: string) {
  return {
    recordType: "workgraph", schemaVersion: 1, ownerUserId: owner, version: row?.row_version ?? 1,
    createdAt: row?.created_at ?? 0, updatedAt: row?.updated_at ?? 0,
    provenance: row ? recordProvenance(row) : { actor: { type: "system", id: "workgraph_defaults" } },
    id: "workgraph_default", defaults: { execution: row?.defaults ?? {} },
  }
}

async function changes(
  ctx: GenericQueryCtx<DataModel>,
  organization: string,
  owner: string,
  kind: string,
  input: Record<string, any>,
) {
  const organizationId = organization as Id<"orgs">
  const ownerUserId = owner as Id<"users">
  const streamId = kind === "stream_changes" ? requireText(input.streamId, "streamId") : undefined
  const scope = streamId ? { type: "stream" as const, streamId } : { type: "all" as const }
  const after = input.after === undefined ? 0 : readChangeCursor(input.after, organization, owner, scope)
  const limit = requireLimit(input.limit ?? 50)
  const primary = kind === "stream_changes"
    ? await ctx.db.query("workgraph_changes").withIndex("by_tenant_stream_cursor", (q) => q.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("stream_id", streamId).gt("cursor", after)).filter((q) => q.eq(q.field("organization_id"), organizationId)).take(limit)
    : await ctx.db.query("workgraph_changes")
      .withIndex("by_tenant", (q) => q
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .gt("_creationTime", after))
      .take(limit)
  const deliveredEventIds = new Set(
    Array.isArray(input.deliveredEventIds)
      ? input.deliveredEventIds.filter((id): id is string => typeof id === "string")
      : [],
  )
  const primaryIds = new Set(primary.map((row: any) => row.id))
  const supplemental = kind === "changes" && after > 0 && deliveredEventIds.size > 0
    ? (await ctx.db.query("workgraph_changes")
      .withIndex("by_tenant", (q) => q
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .gt("_creationTime", Math.max(0, after - CHANGE_FEED_OVERLAP_MS))
        .lte("_creationTime", after))
      .take(limit))
      .filter((row: any) => !primaryIds.has(row.id))
    : []
  const supplementalIds = new Set(supplemental.map((row: any) => row.id))
  const ordered = [...supplemental, ...primary]
    .sort((left: any, right: any) => left._creationTime - right._creationTime || String(left.id).localeCompare(String(right.id)))
  return (await Promise.all(ordered.map(async (row: any) => {
    const event = await ctx.db.query("workgraph_events").withIndex("by_tenant_operation", (q) => q.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("operation_id", row.operation_id)).filter((q) => q.eq(q.field("organization_id"), organizationId)).unique()
    if (!event) throw new Error(`Missing WorkGraph event for operation ${row.operation_id}`)
    if (supplementalIds.has(row.id) && deliveredEventIds.has(event.id)) return
    return {
      cursor: createChangeCursor({
        organizationId: organization,
        ownerUserId: owner,
        scope,
        // A late-visible supplemental row is delivered at the caller's current
        // watermark. Primary rows remain strictly forward, so taking the final
        // cursor can never move a consumer backwards or livelock a dense page.
        position: scope.type === "all" ? Math.max(after, row._creationTime) : row.cursor,
      }),
      ownerUserId: owner,
      resource: { type: row.resource_type, id: row.resource_id },
      event: {
        schemaVersion: 1, id: event.id, ownerUserId: owner, ...(event.stream_id ? { streamId: event.stream_id } : {}),
        sequence: event.sequence, type: event.event_type, payload: event.payload,
        provenance: { actor: { type: event.actor_type, id: event.actor_id }, operationId: event.operation_id, requestId: event.request_id ?? event.operation_id },
        occurredAt: event.occurred_at,
      },
    }
  }))).filter((change) => change !== undefined)
}

export const CHANGE_FEED_OVERLAP_MS = 5_000

function streamDto(row: any, owner: string) {
  return {
    recordType: "stream", schemaVersion: 1, ownerUserId: owner, version: row.row_version, createdAt: row.created_at, updatedAt: row.updated_at,
    provenance: recordProvenance(row), id: row.id,
    ...(row.parent_stream_id === undefined ? {} : { parentStreamId: row.parent_stream_id }),
    title: row.title, ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.charter === undefined ? {} : { charter: row.charter }),
    ...(row.master_status === undefined ? {} : { masterStatus: row.master_status }),
    ...(row.notes_source === undefined ? {} : { notesSource: ref(row.notes_source) }),
    ...(row.public_pr_confirmed_at === undefined ? {} : { publicPrConfirmedAt: row.public_pr_confirmed_at }),
    lifecycleState: row.lifecycle_state, visibility: row.visibility, pinned: row.pinned, executionDefaults: row.execution_defaults ?? {},
    ...(row.spend === undefined ? {} : {
      spend: {
        ...(row.spend.total_usd === undefined ? {} : { totalUsd: row.spend.total_usd }),
        totalTokens: row.spend.total_tokens,
        byProfile: (row.spend.by_profile ?? []).map((profile: {
          profile: string
          total_usd?: number
          total_tokens: number
        }) => ({
          profile: profile.profile,
          ...(profile.total_usd === undefined ? {} : { totalUsd: profile.total_usd }),
          totalTokens: profile.total_tokens,
        })),
        asOf: row.spend.as_of,
        ...(row.spend.as_of_message_id === undefined ? {} : { asOfMessageId: row.spend.as_of_message_id }),
        ...(row.spend.day_start === undefined ? {} : { dayStart: row.spend.day_start }),
        ...(row.spend.day_usd === undefined ? {} : { dayUsd: row.spend.day_usd }),
        ...(row.spend.day_tokens === undefined ? {} : { dayTokens: row.spend.day_tokens }),
      },
    }),
    activityGranularity: row.activity_granularity ?? "progress",
    activity: streamActivity(row),
    ...(row.envelope === undefined ? {} : { envelope: row.envelope }),
    ...(row.replacement_reset === undefined ? {} : { replacementReset: row.replacement_reset }),
    durableEffectCount: row.durable_effect_count,
    sourceRevisionRefs: refs(row.source_revision_refs),
  }
}

/** Project the exact contract shape. Deployed rows can still carry recap-era
 *  keys inside `activity` (`recapDueAt`, `lastRecapId`): the contract dropped
 *  them, but `activity` is stored as v.any() so no schema push rewrote the
 *  rows. Passing the stored object through fails the strict snapshot parse in
 *  the HTTP router and turns the whole page into a 500. */
export function streamActivity(row: any) {
  return { lastActivityAt: row.activity?.lastActivityAt ?? row.updated_at }
}

function sourceDto(row: any, owner: string) {
  return {
    id: row.id, ownerUserId: owner, title: row.title, latestRevisionId: row.latest_revision_id,
    revisionCount: row.latest_revision_number, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function outcomeDto(row: any, owner: string) {
  return {
    recordType: "outcome", ...base(row, owner), id: row.id, streamId: row.stream_id, title: row.title,
    ...(row.description === undefined ? {} : { description: row.description }), state: row.state, successCriteria: row.success_criteria,
    evidenceIds: row.evidence_ids, ...(row.execution_defaults === undefined ? {} : { executionDefaults: row.execution_defaults }),
    sourceRevisionRefs: refs(row.source_revision_refs), ...(row.closed_at === undefined ? {} : { closedAt: row.closed_at }),
    ...(row.closed_by === undefined ? {} : { closedBy: row.closed_by }), ...(row.close_reason === undefined ? {} : { closeReason: row.close_reason }),
    ...(row.reopened_at === undefined ? {} : { reopenedAt: row.reopened_at }), ...(row.reopen_reason === undefined ? {} : { reopenReason: row.reopen_reason }),
  }
}

async function workItemDto(ctx: any, organization: string, row: any, owner: string) {
  const dependencies = await ctx.db.query("workgraph_work_item_dependencies").withIndex("by_tenant_item", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("work_item_id", row.id))
    .filter((q: any) => q.eq(q.field("organization_id"), organization)).collect()
  return {
    recordType: "work_item", ...base(row, owner), id: row.id, streamId: row.stream_id,
    ...(row.parent_task_id === undefined ? {} : { parentTaskId: row.parent_task_id }),
    ...(row.outcome_id === undefined ? {} : { outcomeId: row.outcome_id }), title: row.title,
    ...(row.description === undefined ? {} : { description: row.description }), state: row.state, priority: row.priority,
    dependencyIds: dependencies.map((dependency: any) => dependency.depends_on_work_item_id), sourceRevisionRefs: refs(row.source_revision_refs),
    completionContract: row.completion_contract, evidenceIds: row.evidence_ids,
    ...(row.execution_defaults === undefined ? {} : { executionDefaults: row.execution_defaults }),
    ...(row.created_by_actor_type === undefined ? {} : { createdByActorType: row.created_by_actor_type }),
    ...(row.created_by_actor_id === undefined ? {} : { createdByActorId: row.created_by_actor_id }),
    ...(row.origin_run_id === undefined ? {} : { originRunId: row.origin_run_id }),
    ...(row.auto_admitted === undefined ? {} : { autoAdmitted: row.auto_admitted }),
    ...(row.abandoned_at === undefined ? {} : { abandonedAt: row.abandoned_at }), ...(row.abandon_reason === undefined ? {} : { abandonReason: row.abandon_reason }),
  }
}

function runDto(row: any, owner: string) {
  return {
    recordType: "run", ...base(row, owner), id: row.id, streamId: row.stream_id, workItemId: row.work_item_id,
    runNumber: row.run_number, generation: row.generation, state: row.state, resolvedExecution: row.resolved_execution, admittedAt: row.admitted_at,
    executionKind: row.execution_kind ?? "managed",
    ...(row.started_at === undefined ? {} : { startedAt: row.started_at }), ...(row.finished_at === undefined ? {} : { finishedAt: row.finished_at }),
    ...(row.result === undefined ? {} : { result: {
      summary: row.result.summary,
      artifactRefs: row.result.artifactRefs ?? row.result.artifacts,
      finishedAt: row.result.finishedAt ?? row.finished_at,
    } }), ...(row.parked_reason === undefined ? {} : { parkedReason: row.parked_reason }),
    resumeAttempts: row.resume_attempts ?? 0,
    sourceRevisionRefs: refs(row.source_revision_refs),
  }
}

function runDetailDto(row: any, owner: string) {
  const executionReferences = {
    ...(row.session_id === undefined ? {} : { sessionId: row.session_id }),
    ...(row.envelope_id === undefined ? {} : { workspaceId: row.envelope_id }),
    ...(row.child_workspace_id === undefined ? {} : { childWorkspaceId: row.child_workspace_id }),
  }
  return RunDetailDtoSchema.parse({
    run: runDto(row, owner),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

async function decisionDto(ctx: any, organization: string, row: any, owner: string) {
  const affected = await ctx.db.query("workgraph_decision_work_items").withIndex("by_tenant_decision", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("decision_id", row.id))
    .filter((q: any) => q.eq(q.field("organization_id"), organization)).collect()
  return {
    recordType: "decision", ...base(row, owner), id: row.id, streamId: row.stream_id, state: row.state, question: row.question,
    options: row.options, ...(row.recommendation_option_id === undefined ? {} : { recommendationOptionId: row.recommendation_option_id }),
    ...(row.rationale === undefined ? {} : { rationale: row.rationale }), affectedWorkItemIds: affected.map((link: any) => link.work_item_id),
    sourceRevisionRefs: refs(row.source_revision_refs), ...(row.answer === undefined ? {} : { answer: row.answer }),
    ...(row.dismissed_at === undefined ? {} : { dismissedAt: row.dismissed_at }), ...(row.dismiss_reason === undefined ? {} : { dismissReason: row.dismiss_reason }),
  }
}

function admissionDto(row: any, owner: string) {
  const common = {
    recordType: "admission_proposal", ...base(row, owner), id: row.id, state: row.state, source: ref(row.source),
    ...(row.previous_source === undefined ? {} : { previousSource: ref(row.previous_source) }), ...(row.diff_summary === undefined ? {} : { diffSummary: row.diff_summary }),
    generation: row.generation,
  }
  if (row.state === "planning" || row.state === "planning_failed") return AdmissionProposalDtoSchema.parse(common)
  const reviewable = {
    ...common,
    suggestedPlacement: row.suggested_placement ? camelPlacement(row.suggested_placement) : undefined,
    proposedOutcomes: Array.isArray(row.proposed_outcomes) ? row.proposed_outcomes.map(camelOutcome) : undefined,
    proposedWorkItems: Array.isArray(row.proposed_work_items) ? row.proposed_work_items.map(camelItem) : undefined,
    placementMatches: row.placement_matches,
    duplicateMatches: row.duplicate_matches,
  }
  const parsed = AdmissionProposalDtoSchema.safeParse(reviewable)
  if (parsed.success) return parsed.data
  return AdmissionProposalDtoSchema.parse({
    ...common,
    state: "planning_failed",
    generation: {
      method: "planning_failed",
      run: 0,
      reason: "Retired deterministic or incomplete admission plan is non-authoritative",
      invalidatedAt: row.updated_at,
      retryable: Boolean(row.source),
    },
  })
}

function base(row: any, owner: string) {
  return { schemaVersion: 1, ownerUserId: owner, version: row.row_version, createdAt: row.created_at, updatedAt: row.updated_at, provenance: recordProvenance(row) }
}
function recordProvenance(row: any) { return { actor: row.provenance?.actor ?? { type: "system", id: "convex" }, ...(row.provenance?.operationId ? { operationId: row.provenance.operationId } : {}) } }
function refs(values: any[] | undefined) { return (values ?? []).map(ref) }
function ref(value: any) { return { workSourceId: value.work_source_id, revisionId: value.revision_id, contentHash: value.content_hash } }
function camelPlacement(value: any) { return value.mode === "existing" ? { mode: "existing", streamId: value.streamId ?? value.stream_id } : { mode: "new_stream", streamTitle: value.streamTitle ?? value.stream_title } }
function camelOutcome(value: any) { return { key: value.key, title: value.title, ...(value.description === undefined ? {} : { description: value.description }), successCriteria: value.successCriteria ?? value.success_criteria, execution: value.execution } }
function camelItem(value: any) { return { key: value.key, ...(value.outcomeKey ?? value.outcome_key ? { outcomeKey: value.outcomeKey ?? value.outcome_key } : {}), title: value.title, ...(value.description === undefined ? {} : { description: value.description }), dependencyKeys: value.dependencyKeys ?? value.dependency_keys, completionContract: value.completionContract ?? value.completion_contract, execution: value.execution } }
function requireText(value: unknown, field: string) { if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`); return value }
function requireLimit(value: unknown) { const limit = Number(value); if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error("Invalid limit"); return limit }

async function owned(ctx: any, table: string, organization: string, owner: string, id: string) {
  return ctx.db.query(table).withIndex("by_tenant", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query: any) => query.eq(query.field("id"), id)).unique()
}
