import { evaluateCompletionContract } from "@claxedo/workgraph/domain"
import { AdmissionProposalDtoSchema, AttemptDetailDtoSchema, AttentionCursorError, AttentionItemSchema, AttentionPageSchema, EvidenceDtoSchema, EvidencePageCursorError, EvidencePageSchema, SnapshotResumeCursorError, WorkItemAttemptPageCursorError, WorkItemAttemptPageSchema, compareEvidenceCursorPosition, compareSnapshotCursorPosition, compareWorkItemAttemptPosition, createAttentionCursor, createEvidencePageCursor, createSnapshotResumeCursor, createWorkItemAttemptPageCursor, readAttentionCursor, readEvidencePageCursor, readSnapshotResumeCursor, readWorkItemAttemptPageCursor, type EvidenceSubject } from "@claxedo/workgraph/contracts"
import { ConvexError, v } from "convex/values"
import { authedQuery, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, requireOwnedWorkGraphContext, requireTrustedWorkGraphOwnerSubject } from "./workgraphModel"
import { attentionPositionKey } from "./workgraphAttention"

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
  v.object({ kind: v.literal("changes"), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("stream_changes"), streamId: v.string(), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("work_item"), workItemId: v.string() }),
  v.object({ kind: v.literal("work_item_detail"), workItemId: v.string() }),
  v.object({ kind: v.literal("work_item_attempts"), workItemId: v.string(), limit: v.number(), after: v.optional(v.string()) }),
  v.object({ kind: v.literal("admission_proposal"), proposalId: v.string() }),
  v.object({ kind: v.literal("attempt"), attemptId: v.string() }),
  v.object({ kind: v.literal("decision"), decisionId: v.string() }),
  v.object({ kind: v.literal("recap"), recapId: v.string() }),
  v.object({ kind: v.literal("evidence"), evidenceId: v.string() }),
  v.object({ kind: v.literal("evidence_list"), subject: evidenceSubject, limit: v.number(), after: v.optional(v.string()) }),
)
const ownerQueryArgs = { query }

export const read = authedQuery({
  args: ownerQueryArgs,
  handler: async (ctx, args) => {
    const owned = await requireOwnedWorkGraphContext(ctx)
    return readWorkGraphProjection(ctx, String(owned.owner_user_id), args.query.kind, args.query)
  },
})

export const readForService = serviceQuery({
  args: { ...ownerQueryArgs, owner_subject: v.string() },
  handler: async (ctx, args) => {
    const owner = await requireTrustedWorkGraphOwnerSubject(ctx, args.service_token, args.owner_subject)
    return readWorkGraphProjection(ctx, String(owner._id), args.query.kind, args.query)
  },
})

/** Shared projection implementation keeps interactive and service reads identical. */
export async function readWorkGraphProjection(ctx: any, owner: string, kind: string, input: Record<string, any>) {
  await assertWorkGraphOwnerReadable(ctx, owner)
  if (kind === "defaults") return defaultsDto(await owned(ctx, "workgraphs", owner, "workgraph_default"), owner)
  if (kind === "stream") {
    const stream = await owned(ctx, "workgraph_streams", owner, requireText(input.streamId, "streamId"))
    return stream ? streamDto(stream, owner) : null
  }
  if (kind === "source_revision") {
    const revision = await owned(ctx, "work_source_revisions", owner, requireText(input.revisionId, "revisionId"))
    if (!revision || revision.work_source_id !== requireText(input.workSourceId, "workSourceId")) return null
    return {
      id: revision.id, workSourceId: revision.work_source_id, revisionNumber: revision.revision_number,
      content: revision.content, contentHash: revision.content_hash, origin: revision.origin,
      createdAt: revision.created_at, createdBy: revision.created_by,
    }
  }
  if (kind === "source") {
    const source = await owned(ctx, "work_sources", owner, requireText(input.workSourceId, "workSourceId"))
    return source ? sourceDto(source, owner) : null
  }
  if (kind === "sources") {
    const limit = requireLimit(input.limit)
    const result = await ctx.db.query("work_sources").withIndex("by_owner", (q: any) => q.eq("owner_user_id", owner))
      .paginate({ cursor: input.after ?? null, numItems: limit })
    return {
      sources: result.page.map((row: any) => sourceDto(row, owner)),
      hasMore: !result.isDone,
      ...(!result.isDone ? { nextCursor: result.continueCursor } : {}),
    }
  }
  if (kind === "work_item") {
    const item = await owned(ctx, "workgraph_work_items", owner, requireText(input.workItemId, "workItemId"))
    if (!item) return null
    const evidence = await ctx.db.query("workgraph_evidence")
      .withIndex("by_owner_subject", (q: any) => q.eq("owner_user_id", owner).eq("subject_type", "work_item").eq("subject_id", item.id)).collect()
    const subject = { type: "work_item" as const, workItemId: item.id }
    const normalized = evidence.map((row: any) => ({
      ...row.reference, id: row.id, subject, recordedAt: row.created_at, recordedBy: row.provenance.actor,
    }))
    return { ...await workItemDto(ctx, item, owner), completionSatisfied: evaluateCompletionContract(item.completion_contract, subject as any, normalized as any).satisfied }
  }
  if (kind === "work_item_detail") {
    const item = await owned(ctx, "workgraph_work_items", owner, requireText(input.workItemId, "workItemId"))
    return item ? workItemDto(ctx, item, owner) : null
  }
  if (kind === "work_item_attempts") {
    try {
      return await workItemAttemptsPage(ctx, owner, input)
    } catch (error) {
      if (error instanceof WorkItemAttemptPageCursorError) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "admission_proposal") {
    const proposal = await owned(ctx, "workgraph_admission_proposals", owner, requireText(input.proposalId, "proposalId"))
    return proposal ? admissionDto(proposal, owner) : null
  }
  if (kind === "attempt") {
    const attempt = await owned(ctx, "workgraph_attempts", owner, requireText(input.attemptId, "attemptId"))
    return attempt ? attemptDetailDto(attempt, owner) : null
  }
  if (kind === "decision") {
    const decision = await owned(ctx, "workgraph_decisions", owner, requireText(input.decisionId, "decisionId"))
    return decision ? decisionDto(ctx, decision, owner) : null
  }
  if (kind === "recap") {
    const recap = await owned(ctx, "workgraph_recaps", owner, requireText(input.recapId, "recapId"))
    return recap ? recapDto(recap, owner) : null
  }
  if (kind === "evidence") {
    const evidence = await owned(ctx, "workgraph_evidence", owner, requireText(input.evidenceId, "evidenceId"))
    return evidence ? evidenceDto(ctx, evidence, owner) : null
  }
  if (kind === "evidence_list") {
    try {
      return await evidencePage(ctx, owner, requireEvidenceSubject(input.subject), input)
    } catch (error) {
      if (isEvidencePageCursorError(error)) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "attention") {
    try {
      return await attentionPage(ctx, owner, input)
    } catch (error) {
      if (error instanceof AttentionCursorError) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  if (kind === "snapshot") {
    try {
      return await snapshot(ctx, owner, input)
    } catch (error) {
      if (error instanceof SnapshotResumeCursorError || snapshotCursorError(error)) {
        throw new ConvexError({ code: "cursor_invalid", reason: error.reason })
      }
      throw error
    }
  }
  return changes(ctx, owner, kind, input)
}

async function workItemAttemptsPage(ctx: any, owner: string, input: Record<string, any>) {
  const workItemId = requireText(input.workItemId, "workItemId")
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readWorkItemAttemptPageCursor(input.after, owner, workItemId)
  const rows = await ctx.db.query("workgraph_attempts").withIndex("by_owner_item_attempt", (q: any) => {
    const range = q.eq("owner_user_id", owner).eq("work_item_id", workItemId)
    return resume ? range.gt("attempt_number", resume.attemptNumber) : range
  }).take(limit + 1)
  const ordered = rows
    .filter((row: any) => !resume || compareWorkItemAttemptPosition(
      { attemptNumber: row.attempt_number, id: row.id },
      { attemptNumber: resume.attemptNumber, id: resume.attemptId },
    ) > 0)
    .sort((left: any, right: any) => compareWorkItemAttemptPosition(
      { attemptNumber: left.attempt_number, id: left.id },
      { attemptNumber: right.attempt_number, id: right.id },
    ))
  const page = ordered.slice(0, limit)
  const hasMore = ordered.length > limit
  return WorkItemAttemptPageSchema.parse({
    attempts: page.map((row: any) => attemptDetailDto(row, owner)),
    hasMore,
    ...(hasMore ? {
      nextCursor: createWorkItemAttemptPageCursor({
        ownerUserId: owner,
        workItemId,
        attemptNumber: page.at(-1)!.attempt_number,
        attemptId: page.at(-1)!.id,
      }),
    } : {}),
  })
}

async function attentionPage(ctx: any, owner: string, input: Record<string, any>) {
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readAttentionCursor(input.after, owner)
  const [summary, rows] = await Promise.all([
    ctx.db.query("workgraph_attention_summaries").withIndex("by_owner", (query: any) => query.eq("owner_user_id", owner)).unique(),
    ctx.db.query("workgraph_attention_entries").withIndex("by_owner_position", (query: any) => {
      const range = query.eq("owner_user_id", owner)
      return resume ? range.gt("position_key", attentionPositionKey(resume)) : range
    }).take(limit + 1),
  ])
  if (!summary) {
    const root = await owned(ctx, "workgraphs", owner, "workgraph_default")
    if (root) throw new Error("Attention projection is not initialized for this owner")
  }
  const page = await Promise.all(rows.slice(0, limit).map((row: any) => attentionProjectionItem(ctx, owner, row, summary)))
  const hasMore = rows.length > limit
  return AttentionPageSchema.parse({
    items: page,
    total: summary?.total ?? 0,
    hasMore,
    ...(hasMore ? { nextCursor: createAttentionCursor(owner, page.at(-1)!) } : {}),
  })
}

async function attentionProjectionItem(ctx: any, owner: string, entry: any, summary: any) {
  if (entry.kind === "unorganized_ai_work") {
    const counts = { externalIssues: summary.external_issue_count, sessions: summary.session_count, total: summary.external_issue_count + summary.session_count }
    return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, counts })
  }
  if (entry.kind === "configuration_required") {
    if (entry.source_type === "workgraph_connection_metadata") {
      const row = await ctx.db.query("workgraph_connection_metadata").withIndex("by_owner_connection", (query: any) => query.eq("owner_user_id", owner).eq("connection_id", entry.id)).unique()
      if (!row) throw new Error(`Attention source ${entry.kind}:${entry.id} disappeared during its owner-scoped read`)
      return AttentionItemSchema.parse({
        kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at,
        requirement: { type: "connection", connectionId: row.connection_id, integrationId: row.integration_id, status: row.status, ...(row.account_label === undefined ? {} : { accountLabel: row.account_label }) },
      })
    }
    const row = await owned(ctx, "workgraph_due_jobs", owner, entry.id)
    const marker = row?.payload?.configurationRequirement
    if (!row || marker?.type !== "generation" || typeof row.last_error !== "string" || !row.last_error.trim()) throw new Error(`Attention source ${entry.kind}:${entry.id} is not a generation requirement`)
    return AttentionItemSchema.parse({
      kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at,
      requirement: { type: "generation", jobId: row.id, purpose: marker.purpose, scope: marker.scope, reason: row.last_error },
    })
  }
  const table = entry.source_type
  const row = await owned(ctx, table, owner, entry.id)
  if (!row) throw new Error(`Attention source ${entry.kind}:${entry.id} disappeared during its owner-scoped read`)
  if (entry.kind === "admission_proposal") return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, record: admissionDto(row, owner) })
  if (entry.kind === "decision") return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, record: await decisionDto(ctx, row, owner) })
  if (entry.kind === "work_item") return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, record: await workItemDto(ctx, row, owner) })
  if (entry.kind === "attempt") return AttentionItemSchema.parse({ kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at, record: attemptDto(row, owner) })
  if (entry.kind !== "recap_notification") throw new Error(`Unsupported Attention projection kind ${String(entry.kind)}`)
  const recap = await owned(ctx, "workgraph_recaps", owner, row.recap_id)
  if (!recap) throw new Error(`Attention Recap ${row.recap_id} disappeared during its owner-scoped read`)
  return AttentionItemSchema.parse({
    kind: entry.kind, ownerUserId: owner, id: entry.id, updatedAt: entry.updated_at,
    notification: { id: row.id, ownerUserId: owner, version: row.row_version, kind: "actionable_recap", state: row.state, streamId: row.stream_id, recapId: row.recap_id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.read_at === undefined ? {} : { readAt: row.read_at }) },
    recap: recapDto(recap, owner),
  })
}
async function evidencePage(ctx: any, owner: string, subject: EvidenceSubject, input: Record<string, any>) {
  const limit = requireLimit(input.limit)
  const resume = input.after === undefined ? undefined : readEvidencePageCursor(input.after, owner, subject)
  const subjectId = evidenceSubjectId(subject)
  const query = () => ctx.db.query("workgraph_evidence")
  const rows = (resume ? [
    ...await query().withIndex("by_owner_subject_created_id", (q: any) =>
      q.eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
        .eq("created_at", resume.recordedAt).gt("id", resume.evidenceId)
    ).take(limit + 1),
    ...await query().withIndex("by_owner_subject_created_id", (q: any) =>
      q.eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
        .gt("created_at", resume.recordedAt)
    ).take(limit + 1),
  ] : await query().withIndex("by_owner_subject_created_id", (q: any) =>
    q.eq("owner_user_id", owner).eq("subject_type", subject.type).eq("subject_id", subjectId)
  ).take(limit + 1))
    .sort((left: any, right: any) => compareEvidenceCursorPosition(
      { recordedAt: left.created_at, id: left.id },
      { recordedAt: right.created_at, id: right.id },
    ))
    .slice(0, limit + 1)
  const page = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return EvidencePageSchema.parse({
    evidence: await Promise.all(page.map((row: any) => evidenceDto(ctx, row, owner))),
    hasMore,
    ...(hasMore ? {
      nextCursor: createEvidencePageCursor({
        ownerUserId: owner,
        subject,
        recordedAt: page.at(-1)!.created_at,
        evidenceId: page.at(-1)!.id,
      }),
    } : {}),
  })
}

async function evidenceDto(ctx: any, row: any, owner: string) {
  const evidence = {
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
      .withIndex("by_owner_idempotency", (q: any) => q.eq("owner_user_id", owner).eq("idempotency_key", `${operationId}:integration`))
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

async function snapshot(ctx: any, owner: string, input: Record<string, any>) {
  const limit = requireLimit(input.limit)
  const cursor = await ctx.db.query("workgraph_change_cursors").withIndex("by_owner", (q: any) => q.eq("owner_user_id", owner)).unique()
  const snapshotCursor = String(Math.max(0, (cursor?.next_cursor ?? 1) - 1))
  const resume = input.after === undefined
    ? { offset: 0, capturedAt: Date.now(), position: undefined }
    : readSnapshotResumeCursor(input.after, owner, snapshotCursor)
  const specs = [
    { table: "workgraph_streams", recordType: "stream", dto: (row: any) => streamDto(row, owner) },
    { table: "workgraph_outcomes", recordType: "outcome", dto: (row: any) => outcomeDto(row, owner) },
    { table: "workgraph_work_items", recordType: "work_item", dto: (row: any) => workItemDto(ctx, row, owner) },
    { table: "workgraph_attempts", recordType: "attempt", dto: (row: any) => attemptDto(row, owner) },
    { table: "workgraph_decisions", recordType: "decision", dto: (row: any) => decisionDto(ctx, row, owner) },
    { table: "workgraph_recaps", recordType: "recap", dto: (row: any) => recapDto(row, owner) },
    { table: "workgraph_admission_proposals", recordType: "admission_proposal", dto: (row: any) => admissionDto(row, owner) },
  ]
  const [root, ...batches] = await Promise.all([
    owned(ctx, "workgraphs", owner, "workgraph_default"),
    ...specs.map(async (spec) => Promise.all(
      (await snapshotRows(ctx, owner, spec.table, spec.recordType, resume.position, limit + 1))
        .filter((row: any) => spec.recordType !== "admission_proposal" || row.source)
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
        ownerUserId: owner,
        snapshotCursor,
        offset: resume.offset + page.length,
        capturedAt: resume.capturedAt,
        position: page.at(-1)!,
      }),
    } : {}), capturedAt: resume.capturedAt,
  }
}

async function snapshotRows(
  ctx: any,
  owner: string,
  table: string,
  recordType: string,
  position: Readonly<{ createdAt: number; recordType: string; id: string }> | undefined,
  limit: number,
) {
  const query = () => ctx.db.query(table)
  if (!position) {
    return query().withIndex("by_owner_created_id", (q: any) => q.eq("owner_user_id", owner)).take(limit)
  }
  const sameTimestamp = recordType.localeCompare(position.recordType) < 0
    ? []
    : await query().withIndex("by_owner_created_id", (q: any) => {
      const range = q.eq("owner_user_id", owner).eq("created_at", position.createdAt)
      return recordType === position.recordType ? range.gt("id", position.id) : range
    }).take(limit)
  const later = await query().withIndex("by_owner_created_id", (q: any) =>
    q.eq("owner_user_id", owner).gt("created_at", position.createdAt)
  ).take(limit)
  return [...sameTimestamp, ...later]
    .sort((left, right) => left.created_at - right.created_at || String(left.id).localeCompare(String(right.id)))
    .slice(0, limit)
}

function defaultsDto(row: any, owner: string) {
  return {
    recordType: "workgraph", schemaVersion: 1, ownerUserId: owner, version: row?.row_version ?? 1,
    createdAt: row?.created_at ?? 0, updatedAt: row?.updated_at ?? 0,
    provenance: row ? recordProvenance(row) : { actor: { type: "system", id: "workgraph_defaults" } },
    id: "workgraph_default", defaults: { execution: row?.defaults ?? {}, recap: row?.recap_defaults ?? {} },
  }
}

async function changes(ctx: any, owner: string, kind: string, input: Record<string, any>) {
  const after = input.after === undefined ? 0 : requireCursor(input.after)
  const limit = requireLimit(input.limit ?? 50)
  const rows = kind === "stream_changes"
    ? await ctx.db.query("workgraph_changes").withIndex("by_owner_stream_cursor", (q: any) => q.eq("owner_user_id", owner).eq("stream_id", requireText(input.streamId, "streamId")).gt("cursor", after)).take(limit)
    : await ctx.db.query("workgraph_changes").withIndex("by_owner_cursor", (q: any) => q.eq("owner_user_id", owner).gt("cursor", after)).take(limit)
  return Promise.all(rows.map(async (row: any) => {
    const event = await ctx.db.query("workgraph_events").withIndex("by_owner_operation", (q: any) => q.eq("owner_user_id", owner).eq("operation_id", row.operation_id)).unique()
    if (!event) throw new Error(`Missing WorkGraph event for operation ${row.operation_id}`)
    return {
      cursor: String(row.cursor), ownerUserId: owner, resource: { type: row.resource_type, id: row.resource_id },
      event: {
        schemaVersion: 1, id: event.id, ownerUserId: owner, ...(event.stream_id ? { streamId: event.stream_id } : {}),
        sequence: event.sequence, type: event.event_type, payload: event.payload,
        provenance: { actor: { type: event.actor_type, id: event.actor_id }, operationId: event.operation_id, requestId: event.request_id ?? event.operation_id },
        occurredAt: event.occurred_at,
      },
    }
  }))
}

function streamDto(row: any, owner: string) {
  return {
    recordType: "stream", schemaVersion: 1, ownerUserId: owner, version: row.row_version, createdAt: row.created_at, updatedAt: row.updated_at,
    provenance: recordProvenance(row), id: row.id, title: row.title, ...(row.description === undefined ? {} : { description: row.description }),
    lifecycleState: row.lifecycle_state, visibility: row.visibility, pinned: row.pinned, executionDefaults: row.execution_defaults ?? {},
    recapDefaults: row.recap_defaults ?? {}, ...(row.memory === undefined ? {} : { memory: row.memory }),
    activity: Object.keys(row.activity ?? {}).length ? row.activity : { lastActivityAt: row.updated_at, recapDueAt: row.updated_at + 8 * 60 * 60 * 1000 },
    ...(row.envelope === undefined ? {} : { envelope: row.envelope }), durableEffectCount: row.durable_effect_count,
    sourceRevisionRefs: refs(row.source_revision_refs),
  }
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

async function workItemDto(ctx: any, row: any, owner: string) {
  const dependencies = await ctx.db.query("workgraph_work_item_dependencies").withIndex("by_owner_item", (q: any) => q.eq("owner_user_id", owner).eq("work_item_id", row.id)).collect()
  return {
    recordType: "work_item", ...base(row, owner), id: row.id, streamId: row.stream_id,
    ...(row.outcome_id === undefined ? {} : { outcomeId: row.outcome_id }), title: row.title,
    ...(row.description === undefined ? {} : { description: row.description }), state: row.state, priority: row.priority,
    dependencyIds: dependencies.map((dependency: any) => dependency.depends_on_work_item_id), sourceRevisionRefs: refs(row.source_revision_refs),
    completionContract: row.completion_contract, evidenceIds: row.evidence_ids,
    ...(row.execution_defaults === undefined ? {} : { executionDefaults: row.execution_defaults }),
    ...(row.abandoned_at === undefined ? {} : { abandonedAt: row.abandoned_at }), ...(row.abandon_reason === undefined ? {} : { abandonReason: row.abandon_reason }),
  }
}

function attemptDto(row: any, owner: string) {
  return {
    recordType: "attempt", ...base(row, owner), id: row.id, streamId: row.stream_id, workItemId: row.work_item_id,
    attemptNumber: row.attempt_number, state: row.state, resolvedExecution: row.resolved_execution, admittedAt: row.admitted_at,
    ...(row.started_at === undefined ? {} : { startedAt: row.started_at }), ...(row.finished_at === undefined ? {} : { finishedAt: row.finished_at }),
    ...(row.result === undefined ? {} : { result: row.result }), ...(row.attention_reason === undefined ? {} : { attentionReason: row.attention_reason }),
    sourceRevisionRefs: refs(row.source_revision_refs),
  }
}

function attemptDetailDto(row: any, owner: string) {
  const executionReferences = {
    ...(row.session_id === undefined ? {} : { sessionId: row.session_id }),
    ...(row.envelope_id === undefined ? {} : { workspaceId: row.envelope_id }),
    ...(row.child_workspace_id === undefined ? {} : { childWorkspaceId: row.child_workspace_id }),
  }
  return AttemptDetailDtoSchema.parse({
    attempt: attemptDto(row, owner),
    ...(Object.keys(executionReferences).length ? { executionReferences } : {}),
  })
}

async function decisionDto(ctx: any, row: any, owner: string) {
  const affected = await ctx.db.query("workgraph_decision_work_items").withIndex("by_owner_decision", (q: any) => q.eq("owner_user_id", owner).eq("decision_id", row.id)).collect()
  return {
    recordType: "decision", ...base(row, owner), id: row.id, streamId: row.stream_id, state: row.state, question: row.question,
    options: row.options, ...(row.recommendation_option_id === undefined ? {} : { recommendationOptionId: row.recommendation_option_id }),
    ...(row.rationale === undefined ? {} : { rationale: row.rationale }), affectedWorkItemIds: affected.map((link: any) => link.work_item_id),
    sourceRevisionRefs: refs(row.source_revision_refs), ...(row.answer === undefined ? {} : { answer: row.answer }),
    ...(row.dismissed_at === undefined ? {} : { dismissedAt: row.dismissed_at }), ...(row.dismiss_reason === undefined ? {} : { dismissReason: row.dismiss_reason }),
  }
}

function recapDto(row: any, owner: string) {
  const invalidated = row.generation?.method === "deterministic_fallback" ||
    (row.generation?.state === "succeeded" && !row.generation?.sessionId)
  return {
    recordType: "recap", schemaVersion: 1, ownerUserId: owner, version: 1, createdAt: row.created_at, updatedAt: row.created_at,
    provenance: recordProvenance(row), id: row.id, streamId: row.stream_id,
    ...(row.previous_recap_id === undefined ? {} : { previousRecapId: row.previous_recap_id }), activityRange: row.activity_range,
    summary: row.summary,
    actionableReferences: invalidated ? [] : row.actionable_references,
    generation: invalidated
      ? {
          state: "invalidated",
          model: row.generation?.model ?? { providerId: "opencode", modelId: "legacy" },
          effort: row.generation?.effort ?? "unknown",
          reason: "Retired deterministic Recap fallback is non-authoritative",
          source: "retired_non_session_generation",
        }
      : row.generation,
    sourceRevisionRefs: refs(row.source_revision_refs),
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
      attempt: 0,
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
function requireCursor(value: unknown) { const cursor = Number(value); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid cursor"); return cursor }
function requireLimit(value: unknown) { const limit = Number(value); if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new Error("Invalid limit"); return limit }

async function owned(ctx: any, table: string, owner: string, id: string) {
  return ctx.db.query(table).withIndex("by_owner_id", (q: any) => q.eq("owner_user_id", owner).eq("id", id)).unique()
}
