import { v } from "convex/values"
import { AdmissionAgentPlanSchema, AdmissionProposalGenerationSchema, PublicEventPayloadSchema, WorkGraphCommandSchema } from "@claxedo/workgraph/contracts"
import { rankDuplicateMatches, rankStreamMatches } from "@claxedo/workgraph/matching"
import { authedMutation, serviceMutation } from "./model"
import { requireOwnedWorkGraphContext, requireTrustedWorkGraphOwnerSubject, workGraphOwnerDeletionBarrier } from "./workgraphModel"
import { initializeAttentionProjection, removeAttentionRecord, syncAttentionResource, syncCandidateTransition } from "./workgraphAttention"

const ROOT_ID = "workgraph_default"
const OWNER_EVENT_SEQUENCE = "__workgraph_owner__"
const supported = new Set([
  "update_workgraph_defaults",
  "create_work_source",
  "revise_work_source",
  "create_stream",
  "update_stream",
  "set_stream_lifecycle",
  "create_outcome",
  "update_outcome",
  "create_work_item",
  "update_work_item",
  "cancel_work_item",
  "propose_admission",
  "retry_admission_planning",
  "dismiss_admission",
  "reopen_admission",
  "confirm_admission",
  "set_stream_visibility",
  "propose_decision",
  "answer_decision",
  "dismiss_decision",
  "record_evidence",
  "close_outcome",
  "reopen_outcome",
  "close_stream",
  "delete_stream",
  "execute_stream",
  "execute_work_item",
  "cancel_attempt",
  "retry_work_item",
])

const interactiveArgs = {
  operation_id: v.string(),
  request_id: v.string(),
  command: v.any(),
}

const serviceArgs = {
  ...interactiveArgs,
  owner_subject: v.string(),
  actor_type: v.union(v.literal("agent"), v.literal("system")),
  actor_id: v.string(),
}

export const execute = authedMutation({
  args: interactiveArgs,
  handler: async (ctx, args) => {
    const owned = await requireOwnedWorkGraphContext(ctx)
    return applyWorkGraphCommand(ctx, {
      ownerUserId: owned.owner_user_id,
      actor: { type: "user", id: String(owned.owner_user_id) },
      requestId: args.request_id,
      operationId: args.operation_id,
      command: args.command,
    })
  },
})

export const executeForService = serviceMutation({
  args: serviceArgs,
  handler: async (ctx, args) => {
    const owner = await requireTrustedWorkGraphOwnerSubject(ctx, args.service_token, args.owner_subject)
    const ownerUserId = String(owner._id)
    return applyWorkGraphCommand(ctx, {
      ownerUserId,
      actor: { type: args.actor_type, id: args.actor_id },
      requestId: args.request_id,
      operationId: args.operation_id,
      command: args.command,
    })
  },
})

type CommandInput = {
  ownerUserId: string
  actor: { type: "user" | "agent" | "system"; id: string }
  requestId: string
  operationId: string
  command: Record<string, any>
}

/** Exported for policy tests; production calls it only through the mandatory builders above. */
export async function applyWorkGraphCommand(ctx: any, input: CommandInput) {
  if (!input.operationId.trim() || !input.requestId.trim())
    return failure(input.operationId, "validation_error", "Operation and request IDs are required")
  const parsed = WorkGraphCommandSchema.safeParse(input.command)
  if (!parsed.success) return failure(input.operationId, "validation_error", "Invalid WorkGraph command")
  input.command = parsed.data
  if (!PublicEventPayloadSchema.safeParse(input.command).success)
    return failure(input.operationId, "validation_error", "WorkGraph commands cannot contain credentials")
  if (!supported.has(input.command.type))
    return failure(input.operationId, "internal_error", `Unsupported Convex command: ${input.command.type}`)
  if (await workGraphOwnerDeletionBarrier(ctx, input.ownerUserId)) {
    return failure(input.operationId, "blocked", "WorkGraph owner deletion is in progress")
  }

  const requestHash = await sha256(stableJson(input.command))
  const previous = await ctx.db
    .query("workgraph_operation_results")
    .withIndex("by_owner_id", (q: any) => q.eq("owner_user_id", input.ownerUserId).eq("id", input.operationId))
    .unique()
  if (previous?.request_hash === requestHash) return previous.result
  if (previous) return failure(input.operationId, "idempotency_conflict", "Operation ID already used")

  const now = Date.now()
  await ensureOwnerRoot(ctx, input, now)
  const pending = await applyCommand(ctx, input, now)
  if (!pending.ok) {
    await saveOperation(ctx, input, requestHash, pending.result, now)
    return pending.result
  }

  if (pending.streamId) {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, pending.streamId)
    if (stream) {
      const root = await owned(ctx, "workgraphs", input.ownerUserId, ROOT_ID)
      const quietHours = stream.recap_defaults?.quietHours ?? root?.recap_defaults?.quietHours ?? 8
      await ctx.db.patch(stream._id, {
        activity: { lastActivityAt: now, recapDueAt: now + quietHours * 60 * 60 * 1000 },
        last_activity_at: now,
        quiet_since: now,
        recap_due_at: now + quietHours * 60 * 60 * 1000,
        updated_at: now,
      })
    }
  }

  await syncCommandAttention(ctx, input.ownerUserId, pending)

  const cursor = await allocateCursor(ctx, input.ownerUserId, now)
  const sequenceScope = pending.streamId ?? OWNER_EVENT_SEQUENCE
  const sequence = await allocateSequence(ctx, input.ownerUserId, sequenceScope, now)
  const payload = { ...pending.value, ...(pending.streamId ? { streamId: pending.streamId } : {}) }
  await ctx.db.insert("workgraph_events", {
    owner_user_id: input.ownerUserId,
    id: resourceId("event", input),
    ...(pending.streamId ? { stream_id: pending.streamId } : {}),
    sequence,
    operation_id: input.operationId,
    request_id: input.requestId,
    event_type: pending.type,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    payload,
    occurred_at: now,
    schema_version: 1,
  })
  await ctx.db.insert("workgraph_changes", {
    owner_user_id: input.ownerUserId,
    id: `${resourceId("change", input)}_${cursor}`,
    cursor,
    ...(pending.streamId ? { stream_id: pending.streamId } : {}),
    operation_id: input.operationId,
    resource_type: pending.resourceType,
    resource_id: pending.resourceId,
    change_type: pending.type,
    payload,
    schema_version: 1,
    created_at: now,
  })
  const result = success(input.operationId, cursor, pending.value)
  await saveOperation(ctx, input, requestHash, result, now, cursor)
  return result
}

async function applyCommand(ctx: any, input: CommandInput, now: number): Promise<any> {
  const command = input.command
  if (command.type === "update_workgraph_defaults") {
    const root = await owned(ctx, "workgraphs", input.ownerUserId, ROOT_ID)
    if (!root) return rejected(input.operationId, "not_found", "WorkGraph defaults not found")
    if (root.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "WorkGraph defaults version changed")
    const streams = await ctx.db
      .query("workgraph_streams")
      .withIndex("by_owner", (q: any) => q.eq("owner_user_id", input.ownerUserId))
      .collect()
    await Promise.all(streams.filter((stream: any) => stream.lifecycle_state !== "closed").map((stream: any) => {
      const activity = stream.activity as { lastActivityAt?: number }
      const lastActivityAt = activity.lastActivityAt ?? stream.last_activity_at ?? stream.updated_at
      const quietHours = stream.recap_defaults?.quietHours ?? command.defaults.recap.quietHours ?? 8
      const recapDueAt = lastActivityAt + quietHours * 60 * 60 * 1000
      return ctx.db.patch(stream._id, {
        activity: { ...activity, lastActivityAt, recapDueAt },
        recap_due_at: recapDueAt,
      })
    }))
    await ctx.db.patch(root._id, {
      defaults: command.defaults.execution,
      recap_defaults: command.defaults.recap,
      row_version: root.row_version + 1,
      provenance: { actor: { type: input.actor.type, id: input.actor.id }, operationId: input.operationId },
      updated_at: now,
    })
    return pending("workgraph_defaults_updated", "workgraph", ROOT_ID, { workGraphId: ROOT_ID })
  }
  if (command.type === "execute_work_item" || command.type === "retry_work_item") {
    const item = await owned(ctx, "workgraph_work_items", input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (command.type === "retry_work_item" && item.row_version !== command.expectedVersion) {
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    }
    const admitted = await admitAttempt(ctx, input, item, now)
    if (!admitted.ok) return rejected(input.operationId, admitted.code, admitted.message)
    return pending(
      "attempt_admitted",
      "attempt",
      admitted.attemptId,
      { attemptId: admitted.attemptId, workItemId: item.id, leaseEpoch: admitted.leaseEpoch },
      item.stream_id,
    )
  }
  if (command.type === "execute_stream") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.lifecycle_state === "paused")
      return rejected(input.operationId, "blocked", "Paused Streams do not admit new Attempts")
    if (stream.lifecycle_state === "closed")
      return rejected(input.operationId, "invalid_transition", "Closed Streams do not execute")
    const items = await ctx.db
      .query("workgraph_work_items")
      .withIndex("by_owner_stream", (q: any) => q.eq("owner_user_id", input.ownerUserId).eq("stream_id", stream.id))
      .collect()
    const admissions = []
    for (const item of items.filter((row: any) => !["completed", "abandoned"].includes(row.state))) {
      const admitted = await admitAttempt(ctx, input, item, now)
      if (admitted.ok) admissions.push(admitted)
    }
    if (admissions.length === 0) return rejected(input.operationId, "blocked", "No ready Work Items can be admitted")
    return pending(
      "stream_execution_requested",
      "stream",
      stream.id,
      { attemptIds: admissions.map((item) => item.attemptId) },
      stream.id,
    )
  }
  if (command.type === "cancel_attempt") {
    const attempt = await owned(ctx, "workgraph_attempts", input.ownerUserId, command.attemptId)
    if (!attempt) return rejected(input.operationId, "not_found", "Attempt not found")
    if (attempt.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Attempt version changed")
    if (["result", "failed", "cancelled"].includes(attempt.state))
      return rejected(input.operationId, "invalid_transition", "Attempt is already terminal")
    await ctx.db.patch(attempt._id, {
      cancellation: { state: "pending", requestedAt: now, reason: command.reason },
      attention_reason: `Cancellation requested: ${command.reason}`,
      row_version: attempt.row_version + 1,
      updated_at: now,
    })
    await enqueueControlEffect(ctx, input, now, {
      effectType: "interrupt_attempt",
      streamId: attempt.stream_id,
      idempotencyKey: `${attempt.id}:interrupt`,
      payload: {
        finalize: "cancel",
        attemptId: attempt.id,
        ...(attempt.session_id ? { sessionId: attempt.session_id } : {}),
      },
    })
    const outbox = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_owner_idempotency", (q: any) =>
        q.eq("owner_user_id", input.ownerUserId).eq("idempotency_key", `${attempt.id}:launch`),
      )
      .unique()
    if (outbox && outbox.status === "pending") await ctx.db.patch(outbox._id, { status: "cancelled", updated_at: now })
    return pending(
      "attempt_cancellation_requested",
      "attempt",
      attempt.id,
      { attemptId: attempt.id },
      attempt.stream_id,
    )
  }
  if (command.type === "create_stream") {
    const id = resourceId("stream", input)
    await ctx.db.insert("workgraph_streams", {
      owner_user_id: input.ownerUserId,
      id,
      workgraph_id: ROOT_ID,
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      lifecycle_state: "active",
      visibility: "visible",
      pinned: false,
      execution_defaults: command.execution ?? {},
      recap_defaults: {},
      activity: { lastActivityAt: now, recapDueAt: now + 8 * 60 * 60 * 1000 },
      durable_effect_count: 0,
      source_revision_refs: command.source ? [sourceRef(command.source)] : [],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return pending("stream_created", "stream", id, { streamId: id }, id)
  }
  if (command.type === "update_stream") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    await ctx.db.patch(stream._id, {
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      ...(command.recap === undefined ? {} : { recap_defaults: command.recap }),
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    return pending("stream_updated", "stream", stream.id, { streamId: stream.id }, stream.id)
  }
  if (command.type === "set_stream_lifecycle") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (!validTransition(stream.lifecycle_state, command.state))
      return rejected(input.operationId, "invalid_transition", "Invalid stream transition")
    await ctx.db.patch(stream._id, {
      lifecycle_state: command.state,
      row_version: stream.row_version + 1,
      updated_at: now,
      ...(command.state === "closed" ? { closed_at: now } : {}),
    })
    return pending("stream_lifecycle_changed", "stream", stream.id, { streamId: stream.id }, stream.id)
  }
  if (command.type === "create_work_source") {
    const sourceId = resourceId("source", input)
    const revisionId = resourceId("revision", input)
    const contentHash = await sha256(command.content)
    await ctx.db.insert("work_sources", {
      owner_user_id: input.ownerUserId,
      id: sourceId,
      workgraph_id: ROOT_ID,
      title: command.title,
      source_kind: "manual",
      metadata: {},
      latest_revision_id: revisionId,
      latest_revision_number: 1,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("work_source_revisions", {
      owner_user_id: input.ownerUserId,
      id: revisionId,
      work_source_id: sourceId,
      revision_number: 1,
      content: command.content,
      content_hash: contentHash,
      origin: { kind: "manual" },
      created_by: input.actor,
      schema_version: 1,
      created_at: now,
    })
    return pending("work_source_created", "work_source", sourceId, { workSourceId: sourceId, revisionId })
  }
  if (command.type === "revise_work_source") {
    const source = await owned(ctx, "work_sources", input.ownerUserId, command.workSourceId)
    if (!source) return rejected(input.operationId, "not_found", "Work Source not found")
    if (source.latest_revision_id !== command.expectedRevisionId)
      return rejected(input.operationId, "version_conflict", "Work Source revision changed")
    const revisionId = resourceId("revision", input)
    await ctx.db.insert("work_source_revisions", {
      owner_user_id: input.ownerUserId,
      id: revisionId,
      work_source_id: source.id,
      revision_number: source.latest_revision_number + 1,
      content: command.content,
      content_hash: await sha256(command.content),
      origin: { kind: "manual" },
      created_by: input.actor,
      schema_version: 1,
      created_at: now,
    })
    await ctx.db.patch(source._id, {
      ...(command.title === undefined ? {} : { title: command.title }),
      latest_revision_id: revisionId,
      latest_revision_number: source.latest_revision_number + 1,
      row_version: source.row_version + 1,
      updated_at: now,
    })
    return pending("work_source_revised", "work_source", source.id, { workSourceId: source.id, revisionId })
  }
  if (command.type === "create_outcome") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const id = resourceId("outcome", input)
    await ctx.db.insert("workgraph_outcomes", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: stream.id,
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      state: "active",
      success_criteria: command.successCriteria,
      evidence_ids: [],
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      source_revision_refs: [],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return pending("outcome_created", "outcome", id, { outcomeId: id }, stream.id)
  }
  if (command.type === "update_outcome") {
    const outcome = await owned(ctx, "workgraph_outcomes", input.ownerUserId, command.outcomeId)
    if (!outcome) return rejected(input.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Outcome version changed")
    await ctx.db.patch(outcome._id, {
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.successCriteria === undefined ? {} : { success_criteria: command.successCriteria }),
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      row_version: outcome.row_version + 1,
      updated_at: now,
    })
    return pending("outcome_updated", "outcome", outcome.id, { outcomeId: outcome.id }, outcome.stream_id)
  }
  if (command.type === "create_work_item") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (command.outcomeId) {
      const outcome = await owned(ctx, "workgraph_outcomes", input.ownerUserId, command.outcomeId)
      if (!outcome || outcome.stream_id !== stream.id)
        return rejected(input.operationId, "not_found", "Outcome not found")
    }
    for (const dependencyId of command.dependencyIds ?? []) {
      const dependency = await owned(ctx, "workgraph_work_items", input.ownerUserId, dependencyId)
      if (!dependency || dependency.stream_id !== stream.id)
        return rejected(input.operationId, "not_found", "Dependency not found")
    }
    const id = resourceId("work_item", input)
    await ctx.db.insert("workgraph_work_items", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: stream.id,
      ...(command.outcomeId === undefined ? {} : { outcome_id: command.outcomeId }),
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      state: "pending",
      priority: command.priority ?? 0,
      source_revision_refs: command.source ? [sourceRef(command.source)] : [],
      completion_contract: command.completionContract,
      evidence_ids: [],
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await Promise.all(
      (command.dependencyIds ?? []).map((dependencyId: string, index: number) =>
        ctx.db.insert("workgraph_work_item_dependencies", {
          owner_user_id: input.ownerUserId,
          id: `${resourceId("dependency", input)}_${index}`,
          work_item_id: id,
          stream_id: stream.id,
          depends_on_work_item_id: dependencyId,
          dependency_kind: "blocks",
          schema_version: 1,
          created_at: now,
        }),
      ),
    )
    return pending("work_item_created", "work_item", id, { workItemId: id }, stream.id)
  }
  if (command.type === "update_work_item") {
    const item = await owned(ctx, "workgraph_work_items", input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (command.outcomeId) {
      const outcome = await owned(ctx, "workgraph_outcomes", input.ownerUserId, command.outcomeId)
      if (!outcome || outcome.stream_id !== item.stream_id)
        return rejected(input.operationId, "not_found", "Outcome not found")
    }
    const dependencyIds = command.dependencyIds ?? []
    if (dependencyIds.includes(item.id) || new Set(dependencyIds).size !== dependencyIds.length) {
      return rejected(
        input.operationId,
        "validation_error",
        "Dependencies must be unique and cannot reference the Work Item",
      )
    }
    const dependencies = await Promise.all(
      dependencyIds.map((id: string) => owned(ctx, "workgraph_work_items", input.ownerUserId, id)),
    )
    if (command.dependencyIds && dependencies.some((row: any) => !row || row.stream_id !== item.stream_id)) {
      return rejected(input.operationId, "not_found", "Dependency not found")
    }
    await ctx.db.patch(item._id, {
      ...(command.outcomeId === undefined ? {} : { outcome_id: command.outcomeId ?? undefined }),
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.priority === undefined ? {} : { priority: command.priority }),
      ...(command.completionContract === undefined ? {} : { completion_contract: command.completionContract }),
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      row_version: item.row_version + 1,
      updated_at: now,
    })
    if (command.dependencyIds) {
      await deleteRows(
        await ctx.db
          .query("workgraph_work_item_dependencies")
          .withIndex("by_owner_item", (q: any) => q.eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id))
          .collect(),
        ctx,
      )
      await Promise.all(
        dependencyIds.map((dependencyId: string, index: number) =>
          ctx.db.insert("workgraph_work_item_dependencies", {
            owner_user_id: input.ownerUserId,
            id: `${resourceId("dependency", input)}_${index}`,
            work_item_id: item.id,
            stream_id: item.stream_id,
            depends_on_work_item_id: dependencyId,
            dependency_kind: "blocks",
            schema_version: 1,
            created_at: now,
          }),
        ),
      )
    }
    return pending("work_item_updated", "work_item", item.id, { workItemId: item.id }, item.stream_id)
  }
  if (command.type === "cancel_work_item") {
    const item = await owned(ctx, "workgraph_work_items", input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (["completed", "abandoned"].includes(item.state))
      return rejected(input.operationId, "invalid_transition", "Work Item is already terminal")
    const attempts = await ctx.db
      .query("workgraph_attempts")
      .withIndex("by_owner_item_attempt", (q: any) =>
        q.eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id),
      )
      .collect()
    const lease = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_owner_resource", (q: any) =>
        q.eq("owner_user_id", input.ownerUserId).eq("resource_type", "work_item").eq("resource_id", item.id),
      )
      .unique()
    if (attempts.some((attempt: any) => !["result", "failed", "cancelled"].includes(attempt.state)) || lease?.expires_at > now) {
      return rejected(input.operationId, "blocked", "Cancel the active Attempt before abandoning its Work Item")
    }
    await ctx.db.patch(item._id, {
      state: "abandoned",
      abandon_reason: command.reason,
      abandoned_at: now,
      row_version: item.row_version + 1,
      updated_at: now,
    })
    return pending("work_item_updated", "work_item", item.id, { workItemId: item.id }, item.stream_id)
  }
  if (command.type === "set_stream_visibility") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (stream.visibility === command.visibility)
      return rejected(input.operationId, "invalid_transition", "Stream visibility is unchanged")
    await ctx.db.patch(stream._id, {
      visibility: command.visibility,
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    return pending("stream_visibility_changed", "stream", stream.id, { streamId: stream.id }, stream.id)
  }
  if (command.type === "propose_decision") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const optionIds = command.options.map((option: any) => option.id)
    if (
      new Set(optionIds).size !== optionIds.length ||
      (command.recommendationOptionId && !optionIds.includes(command.recommendationOptionId))
    ) {
      return rejected(input.operationId, "validation_error", "Decision options are invalid")
    }
    const affected = await Promise.all(
      command.affectedWorkItemIds.map((id: string) => owned(ctx, "workgraph_work_items", input.ownerUserId, id)),
    )
    if (affected.some((item: any) => !item || item.stream_id !== stream.id))
      return rejected(input.operationId, "not_found", "Affected Work Item not found")
    const id = resourceId("decision", input)
    await ctx.db.insert("workgraph_decisions", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: stream.id,
      state: "pending",
      question: command.question,
      options: command.options,
      ...(command.recommendationOptionId ? { recommendation_option_id: command.recommendationOptionId } : {}),
      ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
      source_revision_refs: [],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await Promise.all(
      command.affectedWorkItemIds.map((workItemId: string, index: number) =>
        ctx.db.insert("workgraph_decision_work_items", {
          owner_user_id: input.ownerUserId,
          id: `${resourceId("decision_item", input)}_${index}`,
          decision_id: id,
          stream_id: stream.id,
          work_item_id: workItemId,
          schema_version: 1,
          created_at: now,
        }),
      ),
    )
    return pending("decision_proposed", "decision", id, { decisionId: id }, stream.id)
  }
  if (command.type === "answer_decision" || command.type === "dismiss_decision") {
    const decision = await owned(ctx, "workgraph_decisions", input.ownerUserId, command.decisionId)
    if (!decision) return rejected(input.operationId, "not_found", "Decision not found")
    if (decision.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Decision version changed")
    if (decision.state !== "pending")
      return rejected(input.operationId, "invalid_transition", "Decision is not pending")
    if (command.type === "answer_decision") {
      if (!command.optionId && !command.answer)
        return rejected(input.operationId, "validation_error", "An option or answer is required")
      if (command.optionId && !decision.options.some((option: any) => option.id === command.optionId))
        return rejected(input.operationId, "validation_error", "Decision option not found")
      await ctx.db.patch(decision._id, {
        state: "answered",
        answer: {
          ...(command.optionId ? { optionId: command.optionId } : {}),
          ...(command.answer ? { answer: command.answer } : {}),
          answeredAt: now,
          answeredBy: input.actor,
        },
        row_version: decision.row_version + 1,
        updated_at: now,
      })
      return pending("decision_answered", "decision", decision.id, { decisionId: decision.id }, decision.stream_id)
    }
    await ctx.db.patch(decision._id, {
      state: "dismissed",
      dismissed_at: now,
      dismiss_reason: command.reason,
      row_version: decision.row_version + 1,
      updated_at: now,
    })
    return pending("decision_dismissed", "decision", decision.id, { decisionId: decision.id }, decision.stream_id)
  }
  if (command.type === "propose_admission") {
    const revision = await exactSourceRevision(ctx, input.ownerUserId, command.source)
    if (!revision) return rejected(input.operationId, "not_found", "Work Source revision not found")
    const source = await owned(ctx, "work_sources", input.ownerUserId, revision.work_source_id)
    if (!source) return rejected(input.operationId, "not_found", "Work Source not found")
    if (command.targetStreamId && !(await owned(ctx, "workgraph_streams", input.ownerUserId, command.targetStreamId)))
      return rejected(input.operationId, "not_found", "Target Stream not found")
    const id = resourceId("admission", input)
    const evidence = await sourcePlanningEvidence(ctx, input.ownerUserId, {
      title: source.title,
      content: revision.content,
      ...(command.targetStreamId ? { targetStreamId: command.targetStreamId } : {}),
      now,
    })
    await ctx.db.insert("workgraph_admission_proposals", {
      owner_user_id: input.ownerUserId,
      id,
      workgraph_id: ROOT_ID,
      state: "planning",
      source: sourceRef(command.source),
      proposal_kind: "source",
      generation: { method: "planning", attempt: 0, queuedAt: now },
      planning_evidence: evidence,
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("workgraph_due_jobs", {
      owner_user_id: input.ownerUserId,
      id: `source_plan_job_${id}`,
      job_type: "source_plan",
      subject_id: id,
      due_at: now,
      status: "pending",
      payload: { proposalId: id, source: sourceRef(command.source), automaticFailureCount: 0 },
      lease_epoch: 0,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return pending("admission_proposed", "work_source", command.source.workSourceId, { proposalId: id })
  }
  if (command.type === "retry_admission_planning") {
    const proposal = await owned(ctx, "workgraph_admission_proposals", input.ownerUserId, command.proposalId)
    if (!proposal) return rejected(input.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Admission proposal version changed")
    if (proposal.state !== "planning_failed")
      return rejected(input.operationId, "invalid_transition", "Admission planning has not failed")
    if (proposal.generation?.method !== "planning_failed" || proposal.generation.retryable !== true)
      return rejected(input.operationId, "invalid_transition", "Admission planning failure is not retryable")
    if (!proposal.source || !(await exactSourceRevision(ctx, input.ownerUserId, {
      workSourceId: proposal.source.work_source_id,
      revisionId: proposal.source.revision_id,
      contentHash: proposal.source.content_hash,
    }))) return rejected(input.operationId, "version_conflict", "Admission source is no longer current")
    const attempt = typeof proposal.generation.attempt === "number" ? proposal.generation.attempt : 0
    await ctx.db.patch(proposal._id, {
      state: "planning",
      generation: { method: "planning", attempt, queuedAt: now },
      suggested_placement: undefined,
      placement_matches: undefined,
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
      duplicate_matches: undefined,
      row_version: proposal.row_version + 1,
      updated_at: now,
    })
    const job = await owned(ctx, "workgraph_due_jobs", input.ownerUserId, `source_plan_job_${proposal.id}`)
    const payload = { proposalId: proposal.id, source: proposal.source, automaticFailureCount: 0 }
    if (job) await ctx.db.patch(job._id, {
      due_at: now,
      status: "pending",
      payload,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: undefined,
      row_version: job.row_version + 1,
      updated_at: now,
    })
    if (!job) await ctx.db.insert("workgraph_due_jobs", {
      owner_user_id: input.ownerUserId,
      id: `source_plan_job_${proposal.id}`,
      job_type: "source_plan",
      subject_id: proposal.id,
      due_at: now,
      status: "pending",
      payload,
      lease_epoch: 0,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return pending("admission_planning_retried", "admission_proposal", proposal.id, {
      proposalId: proposal.id,
      version: proposal.row_version + 1,
      attempt,
    })
  }
  if (command.type === "dismiss_admission" || command.type === "reopen_admission") {
    const proposal = await owned(ctx, "workgraph_admission_proposals", input.ownerUserId, command.proposalId)
    if (!proposal) return rejected(input.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Admission proposal version changed")
    const expectedState = command.type === "dismiss_admission" ? "proposed" : "dismissed"
    if (proposal.state !== expectedState) {
      return rejected(
        input.operationId,
        "invalid_transition",
        command.type === "dismiss_admission"
          ? "Only a reviewable admission proposal may be dismissed"
          : "Only a dismissed admission proposal may be reopened",
      )
    }
    const generation = AdmissionProposalGenerationSchema.safeParse(proposal.generation)
    if (!generation.success || generation.data.method !== "agent_session" ||
      !AdmissionAgentPlanSchema.safeParse({
        source: proposal.source ? {
          workSourceId: proposal.source.work_source_id,
          revisionId: proposal.source.revision_id,
          contentHash: proposal.source.content_hash,
        } : undefined,
        suggestedPlacement: proposal.suggested_placement,
        placementMatches: proposal.placement_matches,
        proposedOutcomes: proposal.proposed_outcomes,
        proposedWorkItems: proposal.proposed_work_items,
        duplicateMatches: proposal.duplicate_matches,
      }).success) {
      return rejected(input.operationId, "invalid_transition", "Admission proposal is not reviewable")
    }
    const version = proposal.row_version + 1
    await ctx.db.patch(proposal._id, {
      state: command.type === "dismiss_admission" ? "dismissed" : "proposed",
      row_version: version,
      updated_at: now,
    })
    return pending(
      command.type === "dismiss_admission" ? "admission_dismissed" : "admission_reopened",
      "admission_proposal",
      proposal.id,
      { proposalId: proposal.id, version },
    )
  }
  if (command.type === "confirm_admission") return confirmAdmission(ctx, input, command, now)
  if (command.type === "close_outcome" || command.type === "reopen_outcome") {
    const outcome = await owned(ctx, "workgraph_outcomes", input.ownerUserId, command.outcomeId)
    if (!outcome) return rejected(input.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Outcome version changed")
    if (command.type === "close_outcome") {
      const children = await ctx.db
        .query("workgraph_work_items")
        .withIndex("by_owner_outcome_state", (q: any) =>
          q.eq("owner_user_id", input.ownerUserId).eq("outcome_id", outcome.id),
        )
        .collect()
      const hasOpen = children.some((item: any) => !["completed", "abandoned"].includes(item.state))
      const confirmations = await ctx.db
        .query("workgraph_evidence")
        .withIndex("by_owner_subject", (q: any) =>
          q.eq("owner_user_id", input.ownerUserId).eq("subject_type", "outcome").eq("subject_id", outcome.id),
        )
        .collect()
      if (
        hasOpen ||
        !confirmations.some((row: any) => row.evidence_kind === "owner_confirmation" && row.reference.confirmed)
      )
        return rejected(
          input.operationId,
          "blocked",
          "Outcome completion requires finished children and owner confirmation",
        )
      await ctx.db.patch(outcome._id, {
        state: "completed",
        closed_at: now,
        closed_by: input.actor,
        close_reason: command.reason,
        row_version: outcome.row_version + 1,
        updated_at: now,
      })
      return pending(
        "outcome_closed",
        "outcome",
        outcome.id,
        { outcomeId: outcome.id, reason: command.reason },
        outcome.stream_id,
      )
    }
    if (outcome.state !== "completed")
      return rejected(input.operationId, "invalid_transition", "Outcome is not completed")
    await ctx.db.patch(outcome._id, {
      state: "reopened",
      reopened_at: now,
      reopen_reason: command.reason,
      row_version: outcome.row_version + 1,
      updated_at: now,
    })
    return pending(
      "outcome_reopened",
      "outcome",
      outcome.id,
      { outcomeId: outcome.id, reason: command.reason },
      outcome.stream_id,
    )
  }
  if (command.type === "close_stream") {
    const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (!validTransition(stream.lifecycle_state, "closed"))
      return rejected(input.operationId, "invalid_transition", "Invalid stream transition")
    const attempts = await streamRows(ctx, "workgraph_attempts", input.ownerUserId, stream.id)
    await Promise.all(
      attempts
        .filter((attempt: any) => ["admitted", "placing", "running"].includes(attempt.state))
        .map(async (attempt: any) => {
          await ctx.db.patch(attempt._id, {
            cancellation: { state: "pending", requestedAt: now, reason: command.reason },
            attention_reason: `Cancellation requested: ${command.reason}`,
            row_version: attempt.row_version + 1,
            updated_at: now,
          })
        }),
    )
    await enqueueControlEffect(ctx, input, now, {
      effectType: "cleanup_stream",
      streamId: stream.id,
      idempotencyKey: `${stream.id}:close-cleanup`,
      payload: {
        finalize: "close",
        streamId: stream.id,
        sessions: attempts.flatMap((attempt: any) => (attempt.session_id ? [attempt.session_id] : [])),
      },
    })
    await ctx.db.patch(stream._id, {
      closure: { state: "pending", requestedAt: now, reason: command.reason },
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    return pending(
      "stream_closure_requested",
      "stream",
      stream.id,
      { streamId: stream.id, reason: command.reason },
      stream.id,
    )
  }
  if (command.type === "record_evidence") {
    const subjectId = command.subject.type === "stream" ? command.subject.streamId
      : command.subject.type === "work_item" ? command.subject.workItemId
        : command.subject.outcomeId
    const table = command.subject.type === "stream" ? "workgraph_streams"
      : command.subject.type === "work_item" ? "workgraph_work_items"
        : "workgraph_outcomes"
    const subject = await owned(ctx, table, input.ownerUserId, subjectId)
    if (!subject) return rejected(input.operationId, "not_found", "Evidence subject not found")
    const stream = command.subject.type === "stream"
      ? subject
      : await owned(ctx, "workgraph_streams", input.ownerUserId, subject.stream_id)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const id = resourceId("evidence", input)
    await ctx.db.insert("workgraph_evidence", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: subject.stream_id,
      subject_type: command.subject.type,
      subject_id: subjectId,
      evidence_kind: command.evidence.kind,
      summary: command.evidence.summary,
      reference: {
        ...command.evidence,
        requirementId: command.requirementId,
        sourceAttemptId: command.sourceAttemptId,
      },
      provenance: provenance(input),
      schema_version: 1,
      created_at: now,
    })
    if (command.subject.type !== "stream") await ctx.db.patch(subject._id, {
      evidence_ids: [...subject.evidence_ids, id],
      row_version: subject.row_version + 1,
      updated_at: now,
    })
    if (command.evidence.kind === "integration" && command.evidence.effect !== "other") {
      await ctx.db.insert("workgraph_durable_effect_receipts", {
        owner_user_id: input.ownerUserId,
        id: resourceId("receipt", input),
        stream_id: subject.stream_id,
        effect_kind: command.evidence.effect,
        idempotency_key: `${input.operationId}:integration`,
        external_reference: { reference: command.evidence.reference },
        provenance: provenance(input),
        schema_version: 1,
        created_at: now,
      })
      await ctx.db.patch(stream._id, {
        durable_effect_count: stream.durable_effect_count + 1,
        row_version: stream.row_version + 1,
        updated_at: now,
      })
    }
    return pending("evidence_recorded", "evidence", id, { evidenceId: id }, subject.stream_id)
  }
  const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, command.streamId)
  if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
  const receipts = await ctx.db
    .query("workgraph_durable_effect_receipts")
    .withIndex("by_owner_stream_created", (q: any) =>
      q.eq("owner_user_id", input.ownerUserId).eq("stream_id", stream.id),
    )
    .take(1)
  if (receipts.length > 0) return rejected(input.operationId, "close_required", "Durable effects require close")
  if (stream.row_version !== command.expectedVersion)
    return rejected(input.operationId, "version_conflict", "Stream version changed")
  const attempts = await streamRows(ctx, "workgraph_attempts", input.ownerUserId, stream.id)
  await ctx.db.patch(stream._id, {
    deletion: { state: "pending", requestedAt: now },
    row_version: stream.row_version + 1,
    updated_at: now,
  })
  await Promise.all(
    attempts
      .filter((attempt: any) => ["admitted", "placing", "running"].includes(attempt.state))
      .map((attempt: any) =>
        ctx.db.patch(attempt._id, {
          cancellation: { state: "pending", requestedAt: now, reason: "Stream deletion" },
          attention_reason: "Cancellation requested: Stream deletion",
          row_version: attempt.row_version + 1,
          updated_at: now,
        }),
      ),
  )
  await enqueueControlEffect(ctx, input, now, {
    effectType: "cleanup_stream",
    streamId: stream.id,
    idempotencyKey: `${stream.id}:delete-cleanup`,
    payload: {
      finalize: "delete",
      streamId: stream.id,
      sessions: attempts.flatMap((attempt: any) => (attempt.session_id ? [attempt.session_id] : [])),
    },
  })
  return pending("stream_deletion_requested", "stream", stream.id, { streamId: stream.id }, stream.id)
}

async function enqueueControlEffect(
  ctx: any,
  input: CommandInput,
  now: number,
  effect: { effectType: string; streamId: string; idempotencyKey: string; payload: Record<string, unknown> },
) {
  const existing = await ctx.db
    .query("workgraph_outbox")
    .withIndex("by_owner_idempotency", (q: any) =>
      q.eq("owner_user_id", input.ownerUserId).eq("idempotency_key", effect.idempotencyKey),
    )
    .unique()
  if (existing) {
    if (["failed", "cancelled"].includes(existing.status))
      await ctx.db.patch(existing._id, {
        status: "pending",
        available_at: now,
        attempt_count: 0,
        claimed_by: undefined,
        claim_expires_at: undefined,
        last_error: undefined,
        payload: effect.payload,
        updated_at: now,
      })
    return
  }
  await ctx.db.insert("workgraph_outbox", {
    owner_user_id: input.ownerUserId,
    id: `outbox_${effect.idempotencyKey}`,
    operation_id: input.operationId,
    stream_id: effect.streamId,
    effect_type: effect.effectType,
    idempotency_key: effect.idempotencyKey,
    payload: effect.payload,
    status: "pending",
    available_at: now,
    attempt_count: 0,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
}

async function deleteStreamGraph(ctx: any, owner: string, streamId: string) {
  const items = await streamRows(ctx, "workgraph_work_items", owner, streamId)
  const direct = await Promise.all([
    streamRows(ctx, "workgraph_work_item_dependencies", owner, streamId),
    streamRows(ctx, "workgraph_decision_work_items", owner, streamId),
    streamRows(ctx, "workgraph_evidence", owner, streamId),
    ctx.db
      .query("workgraph_durable_effect_receipts")
      .withIndex("by_owner_stream_created", (q: any) => q.eq("owner_user_id", owner).eq("stream_id", streamId))
      .collect(),
    streamRows(ctx, "workgraph_attempts", owner, streamId),
    streamRows(ctx, "workgraph_decisions", owner, streamId),
    ctx.db
      .query("workgraph_recaps")
      .withIndex("by_owner_stream_created", (q: any) => q.eq("owner_user_id", owner).eq("stream_id", streamId))
      .collect(),
    streamRows(ctx, "workgraph_outcomes", owner, streamId),
    streamRows(ctx, "workgraph_leases", owner, streamId),
    streamRows(ctx, "workgraph_outbox", owner, streamId),
    streamRows(ctx, "workgraph_due_jobs", owner, streamId),
    streamRows(ctx, "workgraph_notifications", owner, streamId),
  ])
  const rows = [...new Map([...direct.flat(), ...items].map((row: any) => [row._id, row])).values()]
  await rows.reduce((pending: Promise<unknown>, row: any) => pending.then(() => syncDeletedAttention(ctx, owner, row)), Promise.resolve())
  await deleteRows(rows, ctx)
  const stream = await owned(ctx, "workgraph_streams", owner, streamId)
  if (stream) await ctx.db.delete(stream._id)
}

function syncDeletedAttention(ctx: any, owner: string, row: any) {
  const table = row.notification_kind ? "workgraph_notifications"
    : row.job_type ? "workgraph_due_jobs"
      : row.attempt_number !== undefined ? "workgraph_attempts"
        : row.question !== undefined ? "workgraph_decisions"
          : row.completion_contract !== undefined ? "workgraph_work_items"
            : undefined
  return table ? removeAttentionRecord(ctx, owner, table, row.id) : undefined
}

async function streamRows(ctx: any, table: string, owner: string, streamId: string) {
  return ctx.db
    .query(table)
    .withIndex("by_owner_stream", (q: any) => q.eq("owner_user_id", owner).eq("stream_id", streamId))
    .collect()
}

async function sourcePlanningEvidence(
  ctx: any,
  owner: string,
  input: { title: string; content: string; targetStreamId?: string; now: number },
) {
  const candidate = { title: input.title, body: input.content }
  const [recentRows, pinnedRows] = await Promise.all([
    ctx.db.query("workgraph_streams")
      .withIndex("by_owner_updated", (q: any) => q.eq("owner_user_id", owner))
      .order("desc").take(48),
    ctx.db.query("workgraph_streams")
      .withIndex("by_owner_pinned_updated", (q: any) => q.eq("owner_user_id", owner).eq("pinned", true))
      .order("desc").take(24),
  ])
  const matchable = (row: any, memoryOnly = false) => ({
    id: row.id,
    title: row.title,
    summary: `${row.description ?? ""} ${JSON.stringify(row.memory ?? {})}`,
    pinned: row.pinned,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    ...(memoryOnly ? { memoryOnly: true } : {}),
  })
  const visible = (row: any) => row.visibility === "visible" && row.lifecycle_state !== "closed"
  const recent = recentRows.filter(visible).slice(0, 24).map((row: any) => matchable(row))
  const pinned = pinnedRows.filter(visible).slice(0, 12).map((row: any) => matchable(row))
  const primary = rankStreamMatches([...recent, ...pinned], candidate, input.now)
  const ranked = primary[0]?.confidence === "high"
    ? primary
    : rankStreamMatches([
      ...recent,
      ...pinned,
      ...recentRows.filter((row: any) => visible(row) && row.memory).slice(24, 40).map((row: any) => matchable(row, true)),
    ], candidate, input.now)
  const placementMatches = ranked.slice(0, 4).map((match: any) => ({
    streamId: match.streamId,
    confidence: match.confidence,
    score: match.score,
    reason: match.explanation,
    evidence: [match.explanation],
  }))
  const reviewedPlacements = input.targetStreamId
    ? [{
      streamId: input.targetStreamId,
      confidence: "high",
      score: 1,
      reason: "The owner explicitly selected this Stream.",
      evidence: ["Explicit owner selection"],
    }, ...placementMatches.filter((match: any) => match.streamId !== input.targetStreamId)].slice(0, 4)
    : placementMatches
  const [outcomes, workItems] = await Promise.all([
    ctx.db.query("workgraph_outcomes")
      .withIndex("by_owner_updated", (q: any) => q.eq("owner_user_id", owner))
      .order("desc").take(48),
    ctx.db.query("workgraph_work_items")
      .withIndex("by_owner_updated", (q: any) => q.eq("owner_user_id", owner))
      .order("desc").take(48),
  ])
  const duplicates = [...outcomes.map((row: any) => ({
    subject: { type: "outcome", outcomeId: row.id }, streamId: row.stream_id, title: row.title,
    summary: row.description ?? "", state: row.state, updatedAt: row.updated_at,
  })), ...workItems.map((row: any) => ({
    subject: { type: "work_item", workItemId: row.id }, streamId: row.stream_id, title: row.title,
    summary: row.description ?? "", state: row.state, updatedAt: row.updated_at,
  }))].filter((row) => !["completed", "abandoned"].includes(row.state))
    .sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 48)
  const recommendation = ranked.find((match: any) => match.confidence !== "low")
  return {
    ...(input.targetStreamId
      ? { targetStreamId: input.targetStreamId }
      : recommendation
        ? { targetStreamId: recommendation.streamId }
        : {}),
    placementMatches: reviewedPlacements,
    duplicateMatches: rankDuplicateMatches(duplicates as any, candidate),
  }
}

async function deleteRows(rows: any[], ctx: any) {
  await Promise.all(rows.map((row) => ctx.db.delete(row._id)))
}

async function exactSourceRevision(ctx: any, owner: string, reference: any) {
  const source = await owned(ctx, "work_sources", owner, reference.workSourceId)
  if (!source || source.latest_revision_id !== reference.revisionId) return undefined
  const revision = await owned(ctx, "work_source_revisions", owner, reference.revisionId)
  if (!revision || revision.work_source_id !== source.id || revision.content_hash !== reference.contentHash)
    return undefined
  return revision
}

async function confirmAdmission(ctx: any, input: CommandInput, command: any, now: number) {
  const proposal = await owned(ctx, "workgraph_admission_proposals", input.ownerUserId, command.proposalId)
  if (!proposal) return rejected(input.operationId, "not_found", "Admission proposal not found")
  if (proposal.row_version !== command.expectedVersion)
    return rejected(input.operationId, "version_conflict", "Admission proposal version changed")
  if (proposal.state !== "proposed")
    return rejected(input.operationId, "invalid_transition", "Admission proposal is not open")
  if (proposal.generation?.method !== "agent_session" || typeof proposal.generation.sessionId !== "string" ||
    !proposal.suggested_placement || !Array.isArray(proposal.placement_matches) ||
    !Array.isArray(proposal.proposed_outcomes) || !Array.isArray(proposal.proposed_work_items) ||
    !Array.isArray(proposal.duplicate_matches)) {
    return rejected(input.operationId, "invalid_transition", "Admission proposal has no complete Session-authored plan")
  }
  if (!(await exactSourceRevision(ctx, input.ownerUserId, command.source)))
    return rejected(input.operationId, "version_conflict", "Admission source is not current")
  if (
    !proposal.source ||
    proposal.source.work_source_id !== command.source.workSourceId ||
    proposal.source.revision_id !== command.source.revisionId
  ) {
    return rejected(input.operationId, "version_conflict", "Admission source does not match proposal")
  }
  const intakeCandidate = proposal.intake_candidate_id
    ? await owned(ctx, "workgraph_intake_candidates", input.ownerUserId, proposal.intake_candidate_id)
    : undefined
  if (proposal.intake_candidate_id) {
    const admission = intakeCandidate?.normalized
    if (!intakeCandidate || intakeCandidate.status !== "staged" || admission?.admissionProposalId !== proposal.id ||
      admission?.source?.workSourceId !== command.source.workSourceId || admission?.source?.revisionId !== command.source.revisionId ||
      admission?.source?.contentHash !== command.source.contentHash) {
      return rejected(input.operationId, "version_conflict", "Intake candidate does not match the admission proposal")
    }
  }
  const existingId = "streamId" in command.selection ? command.selection.streamId : undefined
  const existing = existingId ? await owned(ctx, "workgraph_streams", input.ownerUserId, existingId) : undefined
  if (existingId && !existing) return rejected(input.operationId, "not_found", "Selected Stream not found")
  const outcomeKeys = command.outcomes?.map((outcome: any) => outcome.proposalKey) ?? []
  const itemKeys = command.workItems?.map((item: any) => item.proposalKey) ?? []
  if (new Set(outcomeKeys).size !== outcomeKeys.length || new Set(itemKeys).size !== itemKeys.length)
    return rejected(input.operationId, "validation_error", "Admission keys must be unique")
  if (
    (command.workItems ?? []).some(
      (item: any) =>
        (item.outcomeProposalKey && !outcomeKeys.includes(item.outcomeProposalKey)) ||
        item.dependencyProposalKeys?.some((key: string) => !itemKeys.includes(key) || key === item.proposalKey),
    )
  ) {
    return rejected(input.operationId, "validation_error", "Admission references an unknown proposal key")
  }
  if (admissionDependencyCycle((command.workItems ?? []).map((item: any) => ({ key: item.proposalKey, dependencies: item.dependencyProposalKeys ?? [] }))))
    return rejected(input.operationId, "validation_error", "Admission Work Item dependencies contain a cycle")
  const streamId = ["create", "fork"].includes(command.selection.mode) ? resourceId("stream", input) : existingId
  if (["create", "fork"].includes(command.selection.mode)) {
    await ctx.db.insert("workgraph_streams", {
      owner_user_id: input.ownerUserId,
      id: streamId,
      workgraph_id: ROOT_ID,
      title: command.selection.streamTitle,
      lifecycle_state: "active",
      visibility: "visible",
      pinned: false,
      execution_defaults: {},
      recap_defaults: {},
      activity: { lastActivityAt: now, recapDueAt: now + 8 * 60 * 60 * 1000 },
      durable_effect_count: 0,
      source_revision_refs: [sourceRef(command.source)],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
  }
  if (existing) {
    const revision = sourceRef(command.source)
    await ctx.db.patch(existing._id, {
      source_revision_refs: appendSourceRevision(existing.source_revision_refs ?? [], revision),
      row_version: existing.row_version + 1,
      updated_at: now,
    })
  }
  if (command.selection.mode === "replace") {
    const items = await streamRows(ctx, "workgraph_work_items", input.ownerUserId, streamId)
    await Promise.all(
      items
        .filter((item: any) => !["completed", "abandoned"].includes(item.state))
        .map((item: any) =>
          ctx.db.patch(item._id, {
            state: "abandoned",
            abandoned_at: now,
            abandon_reason: "Replaced by confirmed admission",
            row_version: item.row_version + 1,
            updated_at: now,
          }),
        ),
    )
  }
  const outcomes = new Map<string, string>()
  for (const [index, outcome] of (command.outcomes ?? []).entries()) {
    const id = `${resourceId("outcome", input)}_${index}`
    outcomes.set(outcome.proposalKey, id)
    await ctx.db.insert("workgraph_outcomes", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: streamId,
      title: outcome.title,
      ...(outcome.description === undefined ? {} : { description: outcome.description }),
      state: "active",
      success_criteria: outcome.successCriteria,
      execution_defaults: outcome.execution ?? {},
      evidence_ids: [],
      source_revision_refs: [sourceRef(command.source)],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
  }
  const itemIds = new Map<string, string>(
    (command.workItems ?? []).map((item: any, index: number) => [
      item.proposalKey,
      `${resourceId("work_item", input)}_${index}`,
    ]),
  )
  for (const [index, item] of (command.workItems ?? []).entries()) {
    const id = itemIds.get(item.proposalKey)!
    await ctx.db.insert("workgraph_work_items", {
      owner_user_id: input.ownerUserId,
      id,
      stream_id: streamId,
      ...(item.outcomeProposalKey ? { outcome_id: outcomes.get(item.outcomeProposalKey) } : {}),
      title: item.title,
      ...(item.description === undefined ? {} : { description: item.description }),
      state: "pending",
      priority: 0,
      source_revision_refs: [sourceRef(command.source)],
      completion_contract: item.completionContract,
      execution_overrides: item.execution ?? {},
      evidence_ids: [],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await Promise.all(
      (item.dependencyProposalKeys ?? []).map((key: string, dependencyIndex: number) =>
        ctx.db.insert("workgraph_work_item_dependencies", {
          owner_user_id: input.ownerUserId,
          id: `${resourceId("dependency", input)}_${index}_${dependencyIndex}`,
          work_item_id: id,
          stream_id: streamId,
          depends_on_work_item_id: itemIds.get(key),
          dependency_kind: "blocks",
          schema_version: 1,
          created_at: now,
        }),
      ),
    )
  }
  await ctx.db.patch(proposal._id, {
    state: "confirmed",
    disposition: { selection: command.selection, streamId },
    confirmed_at: now,
    row_version: proposal.row_version + 1,
    updated_at: now,
  })
  if (intakeCandidate) {
    const confirmed = { ...intakeCandidate, status: "confirmed", row_version: intakeCandidate.row_version + 1, updated_at: now }
    await ctx.db.patch(intakeCandidate._id, confirmed)
    await syncCandidateTransition(ctx, intakeCandidate, confirmed)
  }
  return pending("admission_confirmed", "stream", streamId, { proposalId: proposal.id, streamId }, streamId)
}

export function appendSourceRevision<Reference extends { work_source_id: string; revision_id: string }>(
  existing: readonly Reference[],
  revision: Reference,
) {
  return existing.some(
    (item) => item.work_source_id === revision.work_source_id && item.revision_id === revision.revision_id,
  )
    ? [...existing]
    : [...existing, revision]
}

function admissionDependencyCycle(items: ReadonlyArray<Readonly<{ key: string; dependencies: readonly string[] }>>) {
  const dependencies = new Map(items.map((item) => [item.key, item.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true
    if (visited.has(key)) return false
    visiting.add(key)
    const cyclic = (dependencies.get(key) ?? []).some(visit)
    visiting.delete(key)
    visited.add(key)
    return cyclic
  }
  return items.some((item) => visit(item.key))
}

async function admitAttempt(ctx: any, input: CommandInput, item: any, now: number) {
  const stream = await owned(ctx, "workgraph_streams", input.ownerUserId, item.stream_id)
  if (!stream) return { ok: false as const, code: "not_found", message: "Stream not found" }
  if (stream.lifecycle_state === "paused")
    return { ok: false as const, code: "blocked", message: "Paused Streams do not admit new Attempts" }
  if (stream.lifecycle_state === "closed")
    return { ok: false as const, code: "invalid_transition", message: "Closed Streams do not execute" }
  if (["completed", "abandoned"].includes(item.state))
    return { ok: false as const, code: "invalid_transition", message: "Finished Work Items do not execute" }
  const dependencies = await ctx.db
    .query("workgraph_work_item_dependencies")
    .withIndex("by_owner_item", (q: any) => q.eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id))
    .collect()
  const blockers = await Promise.all(
    dependencies.map((dependency: any) =>
      owned(ctx, "workgraph_work_items", input.ownerUserId, dependency.depends_on_work_item_id),
    ),
  )
  if (blockers.some((blocker: any) => !blocker || blocker.state !== "completed"))
    return { ok: false as const, code: "blocked", message: "Work Item dependencies are incomplete" }
  const existingLease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_owner_resource", (q: any) =>
      q.eq("owner_user_id", input.ownerUserId).eq("resource_type", "work_item").eq("resource_id", item.id),
    )
    .unique()
  if (existingLease && existingLease.expires_at > now)
    return { ok: false as const, code: "blocked", message: "Work Item already has an active Attempt" }
  if (existingLease) {
    const previous = await owned(ctx, "workgraph_attempts", input.ownerUserId, existingLease.holder_id)
    if (previous && ["admitted", "placing", "running"].includes(previous.state)) {
      const attention = {
        ...previous,
        state: "attention",
        attention_reason: "Execution lease expired",
        row_version: previous.row_version + 1,
        updated_at: now,
      }
      await ctx.db.patch(previous._id, attention)
      await syncAttentionResource(ctx, input.ownerUserId, "workgraph_attempts", previous.id)
    }
    await ctx.db.delete(existingLease._id)
  }
  const outcome = item.outcome_id
    ? await owned(ctx, "workgraph_outcomes", input.ownerUserId, item.outcome_id)
    : undefined
  const root = await owned(ctx, "workgraphs", input.ownerUserId, ROOT_ID)
  const defaults = {
    ...(root?.defaults?.execution ?? root?.defaults ?? {}),
    ...(stream.execution_defaults ?? {}),
    ...(outcome?.execution_defaults ?? {}),
    ...(item.execution_defaults ?? {}),
  }
  const required = [
    "environment",
    "harness",
    "agent",
    "model",
    "effort",
    "tools",
    "connectionIds",
    "isolation",
    "cleanup",
    "integration",
  ]
  if (required.some((field) => defaults[field] === undefined))
    return { ok: false as const, code: "blocked", message: "Execution profile is incomplete" }
  if (defaults.environment?.kind !== "hosted_workspace")
    return {
      ok: false as const,
      code: "blocked",
      message: "Cloud WorkGraph requires a hosted_workspace execution environment",
    }
  const prior = await ctx.db
    .query("workgraph_attempts")
    .withIndex("by_owner_item_attempt", (q: any) =>
      q.eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id),
    )
    .collect()
  const attemptId = `${resourceId("attempt", input)}_${item.id}`
  const leaseEpoch = (existingLease?.epoch ?? 0) + 1
  await ctx.db.insert("workgraph_attempts", {
    owner_user_id: input.ownerUserId,
    id: attemptId,
    stream_id: stream.id,
    work_item_id: item.id,
    attempt_number: prior.length + 1,
    state: "admitted",
    resolved_execution: defaults,
    admitted_at: now,
    source_revision_refs: item.source_revision_refs ?? [],
    provenance: provenance(input),
    row_version: 1,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("workgraph_leases", {
    owner_user_id: input.ownerUserId,
    id: `lease_${attemptId}`,
    resource_type: "work_item",
    resource_id: item.id,
    stream_id: stream.id,
    holder_id: attemptId,
    epoch: leaseEpoch,
    expires_at: now + 10 * 60_000,
    row_version: 1,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.insert("workgraph_outbox", {
    owner_user_id: input.ownerUserId,
    id: `outbox_${attemptId}`,
    operation_id: input.operationId,
    stream_id: stream.id,
    effect_type: "launch_attempt",
    idempotency_key: `${attemptId}:launch`,
    payload: { attemptId, workItemId: item.id, streamId: stream.id, leaseEpoch },
    status: "pending",
    available_at: now,
    attempt_count: 0,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.patch(item._id, { state: "active", row_version: item.row_version + 1, updated_at: now })
  return { ok: true as const, attemptId, leaseEpoch }
}

async function ensureOwnerRoot(ctx: any, input: CommandInput, now: number) {
  if (!(await owned(ctx, "workgraphs", input.ownerUserId, ROOT_ID))) {
    await ctx.db.insert("workgraphs", {
      owner_user_id: input.ownerUserId,
      id: ROOT_ID,
      defaults: {},
      recap_defaults: {},
      provenance: { actor: input.actor, operationId: input.operationId },
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await initializeAttentionProjection(ctx, input.ownerUserId, now)
  }
}

async function syncCommandAttention(ctx: any, owner: string, command: any) {
  const tables = new Map([
    ["admission_proposal", "workgraph_admission_proposals"],
    ["decision", "workgraph_decisions"],
    ["work_item", "workgraph_work_items"],
    ["attempt", "workgraph_attempts"],
  ])
  const resources = [
    tables.has(command.resourceType) ? [tables.get(command.resourceType), command.resourceId] : undefined,
    typeof command.value?.proposalId === "string" ? ["workgraph_admission_proposals", command.value.proposalId] : undefined,
    typeof command.value?.proposalId === "string" ? ["workgraph_due_jobs", `source_plan_job_${command.value.proposalId}`] : undefined,
    typeof command.value?.decisionId === "string" ? ["workgraph_decisions", command.value.decisionId] : undefined,
    typeof command.value?.workItemId === "string" ? ["workgraph_work_items", command.value.workItemId] : undefined,
    typeof command.value?.attemptId === "string" ? ["workgraph_attempts", command.value.attemptId] : undefined,
    ...(Array.isArray(command.value?.attemptIds) ? command.value.attemptIds.map((id: string) => ["workgraph_attempts", id]) : []),
  ].filter((value): value is [string, string] => Boolean(value?.[0] && value[1]))
  await [...new Map(resources.map((resource) => [`${resource[0]}:${resource[1]}`, resource])).values()]
    .reduce((pending: Promise<unknown>, [table, id]) => pending.then(() => syncAttentionResource(ctx, owner, table, id)), Promise.resolve())
}

async function allocateCursor(ctx: any, owner: string, now: number) {
  const row = await ctx.db
    .query("workgraph_change_cursors")
    .withIndex("by_owner", (q: any) => q.eq("owner_user_id", owner))
    .unique()
  if (!row) {
    await ctx.db.insert("workgraph_change_cursors", {
      owner_user_id: owner,
      next_cursor: 2,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return 1
  }
  const cursor = row.next_cursor
  await ctx.db.patch(row._id, { next_cursor: cursor + 1, row_version: row.row_version + 1, updated_at: now })
  return cursor
}

async function allocateSequence(ctx: any, owner: string, streamId: string, now: number) {
  const row = await ctx.db
    .query("workgraph_stream_sequences")
    .withIndex("by_owner_stream", (q: any) => q.eq("owner_user_id", owner).eq("stream_id", streamId))
    .unique()
  if (!row) {
    await ctx.db.insert("workgraph_stream_sequences", {
      owner_user_id: owner,
      stream_id: streamId,
      next_sequence: 2,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    return 1
  }
  const sequence = row.next_sequence
  await ctx.db.patch(row._id, { next_sequence: sequence + 1, row_version: row.row_version + 1, updated_at: now })
  return sequence
}

export async function appendSystemWorkGraphChange(ctx: any, input: Readonly<{
  ownerUserId: string
  operationId: string
  eventId: string
  changeId: string
  resourceType: string
  resourceId: string
  changeType: string
  payload: Record<string, unknown>
  actorId: string
  now: number
}>) {
  const cursor = await allocateCursor(ctx, input.ownerUserId, input.now)
  const sequence = await allocateSequence(ctx, input.ownerUserId, OWNER_EVENT_SEQUENCE, input.now)
  await ctx.db.insert("workgraph_events", {
    owner_user_id: input.ownerUserId,
    id: input.eventId,
    sequence,
    operation_id: input.operationId,
    request_id: input.operationId,
    event_type: input.changeType,
    actor_type: "system",
    actor_id: input.actorId,
    payload: input.payload,
    occurred_at: input.now,
    schema_version: 1,
  })
  await ctx.db.insert("workgraph_changes", {
    owner_user_id: input.ownerUserId,
    id: input.changeId,
    cursor,
    operation_id: input.operationId,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    change_type: input.changeType,
    payload: input.payload,
    schema_version: 1,
    created_at: input.now,
  })
  return cursor
}

async function saveOperation(
  ctx: any,
  input: CommandInput,
  requestHash: string,
  result: any,
  now: number,
  cursor?: number,
) {
  await ctx.db.insert("workgraph_operation_results", {
    owner_user_id: input.ownerUserId,
    id: input.operationId,
    command_type: input.command.type,
    request_hash: requestHash,
    result_status: result.ok ? 200 : 409,
    result,
    ...(cursor === undefined ? {} : { change_cursor: cursor }),
    schema_version: 1,
    created_at: now,
  })
}

async function owned(ctx: any, table: string, owner: string, id: string) {
  const row = await ctx.db
    .query(table)
    .withIndex("by_owner_id", (q: any) => q.eq("owner_user_id", owner).eq("id", id))
    .unique()
  if (table === "workgraph_streams" && (row?.deletion?.state === "pending" || row?.closure?.state === "pending"))
    return undefined
  return row
}

function sourceRef(value: any) {
  return { work_source_id: value.workSourceId, revision_id: value.revisionId, content_hash: value.contentHash }
}

function validTransition(from: string, to: string) {
  const transitions: Record<string, string[]> = {
    active: ["paused", "closed"],
    paused: ["active", "closed"],
    closed: ["reopened"],
    reopened: ["active"],
  }
  return transitions[from]?.includes(to) ?? false
}

function provenance(input: CommandInput) {
  return { actor: input.actor, operationId: input.operationId, requestId: input.requestId }
}

function resourceId(kind: string, input: CommandInput) {
  return `${kind}_${input.ownerUserId}_${input.operationId}`
}

function pending(
  type: string,
  resourceType: string,
  resourceId: string,
  value: Record<string, any>,
  streamId?: string,
) {
  return { ok: true, type, resourceType, resourceId, value, streamId }
}

function rejected(operationId: string, code: string, message: string) {
  return { ok: false, result: failure(operationId, code, message) }
}

function success(operationId: string, cursor: number, value: Record<string, any>) {
  return { ok: true, operationId, cursor: String(cursor), value }
}

function failure(operationId: string, code: string, message: string) {
  return {
    ok: false,
    operationId,
    error: { code, message, retryable: code === "internal_error" || code === "execution_unavailable" },
  }
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
