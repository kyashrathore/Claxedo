import { v } from "convex/values"
import {
  AgentCheckpointDtoSchema,
  AttachSessionTaskInputSchema,
  BindSessionInputSchema,
  RecordAgentCheckpointInputSchema,
  ReleaseSessionBindingInputSchema,
  SessionBindingDtoSchema,
  TaskActivityEntrySchema,
  TaskActivityListInputSchema,
  TaskActivityPageSchema,
  createChangeCursor,
  createTaskActivityPageCursor,
  readTaskActivityPageCursor,
  type AgentCheckpointDto,
  type AttachSessionTaskInput,
  type BindSessionInput,
  type RecordAgentCheckpointInput,
  type ReleaseSessionBindingInput,
  type SessionBindingDto,
  type StreamActivityGranularity,
  type TaskActivityEntry,
} from "@claxedo/workgraph/contracts"
import { WorkGraphSessionBindingError } from "@claxedo/workgraph/ports"
import { serviceMutation, serviceQuery } from "./model"
import { appendOwnedWorkGraphChange } from "./workgraphCommands"
import { requireTrustedWorkGraphTenantSubject, workGraphOwnerDeletionBarrier } from "./workgraphModel"

type ActivityContext = Readonly<{
  organizationId: string
  ownerUserId: string
  actor: Readonly<{ type: "user" | "agent" | "system"; id: string }>
  requestId?: string
  now: number
  command: Record<string, unknown>
}>

type ParsedActivityCommand =
  | Readonly<{ type: "bind_session"; input: BindSessionInput }>
  | Readonly<{ type: "attach_session_task"; input: AttachSessionTaskInput }>
  | Readonly<{ type: "record_agent_checkpoint"; input: RecordAgentCheckpointInput }>
  | Readonly<{ type: "release_session_binding"; input: ReleaseSessionBindingInput }>

type ActivityMutationResult = SessionBindingDto | AgentCheckpointDto

const mutationArgs = {
  organization_id: v.id("orgs"),
  owner_subject: v.string(),
  actor_type: v.union(v.literal("agent"), v.literal("system")),
  actor_id: v.string(),
  request_id: v.string(),
  command: v.any(),
}

export const mutateForService = serviceMutation({
  args: mutationArgs,
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    try {
      return {
        ok: true as const,
        value: await applyWorkGraphActivityMutation(ctx, {
          organizationId: String(tenant.organization_id),
          ownerUserId: String(tenant.owner_user_id),
          actor: { type: args.actor_type, id: args.actor_id },
          requestId: args.request_id,
          now: Date.now(),
          command: args.command,
        }),
      }
    } catch (error) {
      if (error instanceof WorkGraphSessionBindingError) {
        return { ok: false as const, error: { code: error.code, message: error.message } }
      }
      throw error
    }
  },
})

export const readBindingForService = serviceQuery({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    binding_id: v.string(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    return readSessionBinding(
      ctx,
      String(tenant.organization_id),
      String(tenant.owner_user_id),
      args.binding_id,
    )
  },
})

export const readBindingForSessionForService = serviceQuery({
  args: {
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(
      ctx,
      args.service_token,
      args.organization_id,
      args.owner_subject,
    )
    return readSessionBindingForSession(
      ctx,
      String(tenant.organization_id),
      String(tenant.owner_user_id),
      args.session_id,
    )
  },
})

export async function applyWorkGraphActivityMutation(ctx: any, context: ActivityContext) {
  if (await workGraphOwnerDeletionBarrier(ctx, context.organizationId, context.ownerUserId)) {
    throw new WorkGraphSessionBindingError("conflict", "WorkGraph owner deletion is in progress")
  }
  const command = parseActivityCommand(context.command)
  return withOperation(ctx, context, command, () => {
    if (command.type === "bind_session") return bindSession(ctx, context, command.input)
    if (command.type === "attach_session_task") return attachSessionTask(ctx, context, command.input)
    if (command.type === "record_agent_checkpoint") return recordAgentCheckpoint(ctx, context, command.input)
    return releaseSessionBinding(ctx, context, command.input)
  })
}

export async function readSessionBinding(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  bindingId: string,
) {
  const binding = await owned(ctx, "workgraph_session_bindings", organizationId, ownerUserId, bindingId)
  return binding ? bindingDto(ownerUserId, binding) : undefined
}

export async function readSessionBindingForSession(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  sessionId: string,
) {
  const binding = await ctx.db.query("workgraph_session_bindings")
    .withIndex("by_tenant_session", (query: any) => query
      .eq("organization_id", organizationId)
      .eq("owner_user_id", ownerUserId)
      .eq("session_id", sessionId))
    .filter((query: any) => query.eq(query.field("state"), "active"))
    .first()
  return binding ? bindingDto(ownerUserId, binding) : undefined
}

export async function readTaskActivityProjection(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  input: Record<string, unknown>,
) {
  const parsed = TaskActivityListInputSchema.safeParse({
    workItemId: input.workItemId,
    granularity: input.granularity,
    limit: input.limit,
    ...(input.after === undefined ? {} : { after: input.after }),
  })
  if (!parsed.success) throw new Error("Invalid WorkGraph Task activity query")
  const item = await owned(ctx, "workgraph_work_items", organizationId, ownerUserId, parsed.data.workItemId)
  if (!item) throw new WorkGraphSessionBindingError("not_found", "Work Item not found")
  const cursor = parsed.data.after
    ? readTaskActivityPageCursor(
        parsed.data.after,
        organizationId,
        ownerUserId,
        parsed.data.workItemId,
        parsed.data.granularity,
      )
    : undefined
  const sourceLimit = parsed.data.limit + 1
  const changesQuery = filterActivitySource(beforeCursor(
    ctx.db.query("workgraph_changes")
      .withIndex("by_tenant_resource_created_id", (query: any) => activityIndexRange(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("resource_type", "work_item")
        .eq("resource_id", parsed.data.workItemId), "created_at", "event", cursor)),
    "created_at",
    "id",
    "event",
    cursor,
  ), "event", parsed.data.granularity)
  const runsQuery = filterActivitySource(beforeCursor(
    ctx.db.query("workgraph_runs")
      .withIndex("by_tenant_item_updated_id", (query: any) => activityIndexRange(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("work_item_id", parsed.data.workItemId), "updated_at", "run", cursor)),
    "updated_at",
    "id",
    "run",
    cursor,
  ), "run", parsed.data.granularity)
  const checkpointsQuery = filterActivitySource(beforeCursor(
    ctx.db.query("workgraph_agent_checkpoints")
      .withIndex("by_tenant_item_occurred_id", (query: any) => activityIndexRange(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("work_item_id", parsed.data.workItemId), "occurred_at", "checkpoint", cursor)),
    "occurred_at",
    "id",
    "checkpoint",
    cursor,
  ), "checkpoint", parsed.data.granularity)
  const evidenceQuery = beforeCursor(
    ctx.db.query("workgraph_evidence")
      .withIndex("by_tenant_subject_created_id", (query: any) => activityIndexRange(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("subject_type", "work_item")
        .eq("subject_id", parsed.data.workItemId), "created_at", "evidence", cursor)),
    "created_at",
    "id",
    "evidence",
    cursor,
  )
  const [changes, runs, checkpoints, evidence, decisionLinks] = await Promise.all([
    changesQuery.order("desc").take(sourceLimit),
    runsQuery.order("desc").take(sourceLimit),
    checkpointsQuery.order("desc").take(sourceLimit),
    evidenceQuery.order("desc").take(sourceLimit),
    ctx.db.query("workgraph_decision_work_items")
      .withIndex("by_tenant_item", (query: any) => query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("work_item_id", parsed.data.workItemId))
      .take(100),
  ])
  const eventRows = await atOrBeforeCursorTime(
    ctx.db.query("workgraph_events")
      .withIndex("by_tenant_stream_occurred_id", (query: any) => atOrBeforeIndexTime(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("stream_id", item.stream_id), "occurred_at", cursor)),
    "occurred_at",
    cursor,
  ).order("desc").take(Math.max(sourceLimit * 4, 20))
  const events = new Map(eventRows.map((event: any) => [event.operation_id, event]))
  const decisions = (await Promise.all(decisionLinks.map((link: any) =>
    owned(ctx, "workgraph_decisions", organizationId, ownerUserId, link.decision_id))))
    .filter((decision): decision is Record<string, any> => Boolean(decision))
    .filter((decision) => beforePosition(decision.updated_at, `decision:${decision.id}`, cursor))
    .sort((left, right) => compareActivityPosition(
      right.updated_at,
      `decision:${right.id}`,
      left.updated_at,
      `decision:${left.id}`,
    ))
    .slice(0, sourceLimit)
  const runIds = new Set((await ctx.db.query("workgraph_runs")
    .withIndex("by_tenant_item_run", (query: any) => query
      .eq("organization_id", organizationId)
      .eq("owner_user_id", ownerUserId)
      .eq("work_item_id", parsed.data.workItemId))
    .order("desc")
    .take(100)).map((run: any) => run.id))
  const receipts = runIds.size === 0 ? [] : (await beforeCursor(
    ctx.db.query("workgraph_durable_effect_receipts")
      .withIndex("by_tenant_stream_created_id", (query: any) => activityIndexRange(query
        .eq("organization_id", organizationId)
        .eq("owner_user_id", ownerUserId)
        .eq("stream_id", item.stream_id), "created_at", "external_effect", cursor)),
    "created_at",
    "id",
    "external_effect",
    cursor,
  ).order("desc").take(Math.max(sourceLimit * 4, 20)))
    .filter((receipt: any) => receipt.run_id && runIds.has(receipt.run_id))
    .slice(0, sourceLimit)
  const entries = [
    ...changes.map((change: any) => eventActivity(item.stream_id, parsed.data.workItemId, change, events.get(change.operation_id))),
    ...runs.map((run: any) => runActivity(item.stream_id, parsed.data.workItemId, run)),
    ...checkpoints.map((checkpoint: any) => checkpointActivity(item.stream_id, parsed.data.workItemId, checkpoint)),
    ...decisions.map((decision) => decisionActivity(item.stream_id, parsed.data.workItemId, decision)),
    ...evidence.map((record: any) => evidenceActivity(item.stream_id, parsed.data.workItemId, record)),
    ...receipts.map((receipt: any) => receiptActivity(item.stream_id, parsed.data.workItemId, receipt)),
  ]
    .filter((entry) => allowedImportance(parsed.data.granularity).has(entry.importance))
    .sort((left, right) => compareActivityPosition(right.occurredAt, right.id, left.occurredAt, left.id))
  const page = entries.slice(0, parsed.data.limit)
  const hasMore = entries.length > parsed.data.limit
  return TaskActivityPageSchema.parse({
    entries: page,
    hasMore,
    ...(hasMore ? {
      nextCursor: createTaskActivityPageCursor({
        organizationId,
        ownerUserId,
        workItemId: parsed.data.workItemId,
        granularity: parsed.data.granularity,
        occurredAt: page.at(-1)!.occurredAt,
        entryId: page.at(-1)!.id,
      }),
    } : {}),
  })
}

async function bindSession(ctx: any, context: ActivityContext, input: BindSessionInput) {
  if (!await owned(ctx, "workgraph_streams", context.organizationId, context.ownerUserId, input.streamId)) {
    throw new WorkGraphSessionBindingError("not_found", "Stream not found")
  }
  const active = await ctx.db.query("workgraph_session_bindings")
    .withIndex("by_tenant_session", (query: any) => query
      .eq("organization_id", context.organizationId)
      .eq("owner_user_id", context.ownerUserId)
      .eq("session_id", input.sessionId))
    .filter((query: any) => query.eq(query.field("state"), "active"))
    .unique()
  if (active) {
    if (active.stream_id === input.streamId && active.project_id === input.projectId) {
      return { result: bindingDto(context.ownerUserId, active) }
    }
    throw new WorkGraphSessionBindingError("conflict", "Session is already bound to another Stream or project")
  }
  const id = activityId("session_binding", context.ownerUserId, input.operationId)
  await ctx.db.insert("workgraph_session_bindings", {
    organization_id: context.organizationId,
    owner_user_id: context.ownerUserId,
    id,
    stream_id: input.streamId,
    session_id: input.sessionId,
    project_id: input.projectId,
    state: "active",
    bound_at: context.now,
    provenance: { actor: context.actor, operationId: input.operationId },
    row_version: 1,
    schema_version: 1,
    created_at: context.now,
    updated_at: context.now,
  })
  return {
    result: bindingDto(context.ownerUserId, await requireOwned(ctx, "workgraph_session_bindings", context, id, "Session binding")),
    cursor: await appendActivityChange(ctx, context, input.operationId, input.streamId, "session_binding", id, "session_bound", {
      bindingId: id,
      sessionId: input.sessionId,
      projectId: input.projectId,
    }),
  }
}

async function attachSessionTask(ctx: any, context: ActivityContext, input: AttachSessionTaskInput) {
  const binding = await requireOwned(ctx, "workgraph_session_bindings", context, input.bindingId, "Session binding")
  if (binding.state !== "active") throw new WorkGraphSessionBindingError("invalid_transition", "Session binding is released")
  if (binding.row_version !== input.expectedVersion) throw new WorkGraphSessionBindingError("conflict", "Session binding version changed")
  const item = await owned(ctx, "workgraph_work_items", context.organizationId, context.ownerUserId, input.workItemId)
  if (!item || item.stream_id !== binding.stream_id) {
    throw new WorkGraphSessionBindingError("not_found", "Work Item not found in the bound Stream")
  }
  if (binding.current_work_item_id === item.id && binding.current_run_id) {
    throw new WorkGraphSessionBindingError("invalid_transition", "Session is already attached to this Work Item")
  }
  if (binding.current_work_item_id) {
    const [currentItem, currentRun] = await Promise.all([
      owned(ctx, "workgraph_work_items", context.organizationId, context.ownerUserId, binding.current_work_item_id),
      binding.current_run_id
        ? owned(ctx, "workgraph_runs", context.organizationId, context.ownerUserId, binding.current_run_id)
        : undefined,
    ])
    if (!currentItem || !["completed", "abandoned"].includes(currentItem.state) ||
      !currentRun || !["result", "failed", "cancelled"].includes(currentRun.state)) {
      throw new WorkGraphSessionBindingError("invalid_transition", "Settle the current Work Item and Run before attaching another")
    }
  }
  if (item.state !== "pending") throw new WorkGraphSessionBindingError("not_ready", "Work Item is not ready")
  const dependencies = await ctx.db.query("workgraph_work_item_dependencies")
    .withIndex("by_tenant_item", (query: any) => query
      .eq("organization_id", context.organizationId)
      .eq("owner_user_id", context.ownerUserId)
      .eq("work_item_id", item.id))
    .collect()
  const blockers = await Promise.all(dependencies.map((dependency: any) =>
    owned(ctx, "workgraph_work_items", context.organizationId, context.ownerUserId, dependency.depends_on_work_item_id)))
  if (blockers.some((blocker) => !blocker || blocker.state !== "completed")) {
    throw new WorkGraphSessionBindingError("not_ready", "Work Item dependencies are incomplete")
  }
  const decisionLinks = await ctx.db.query("workgraph_decision_work_items")
    .withIndex("by_tenant_item", (query: any) => query
      .eq("organization_id", context.organizationId)
      .eq("owner_user_id", context.ownerUserId)
      .eq("work_item_id", item.id))
    .collect()
  const decisions = await Promise.all(decisionLinks.map((link: any) =>
    owned(ctx, "workgraph_decisions", context.organizationId, context.ownerUserId, link.decision_id)))
  if (decisions.some((decision) => decision && ["proposed", "pending"].includes(decision.state))) {
    throw new WorkGraphSessionBindingError("not_ready", "Work Item requires a pending Decision")
  }
  const activeRun = await ctx.db.query("workgraph_runs")
    .withIndex("by_tenant_item_run", (query: any) => query
      .eq("organization_id", context.organizationId)
      .eq("owner_user_id", context.ownerUserId)
      .eq("work_item_id", item.id))
    .filter((query: any) => query.or(
      query.eq(query.field("state"), "admitted"),
      query.eq(query.field("state"), "placing"),
      query.eq(query.field("state"), "running"),
    ))
    .first()
  if (activeRun) throw new WorkGraphSessionBindingError("not_ready", "Work Item already has an active Run")
  const latest = await ctx.db.query("workgraph_runs")
    .withIndex("by_tenant_item_run", (query: any) => query
      .eq("organization_id", context.organizationId)
      .eq("owner_user_id", context.ownerUserId)
      .eq("work_item_id", item.id))
    .order("desc")
    .first()
  const runId = activityId("run", context.ownerUserId, input.operationId)
  await ctx.db.insert("workgraph_runs", {
    organization_id: context.organizationId,
    owner_user_id: context.ownerUserId,
    id: runId,
    stream_id: item.stream_id,
    work_item_id: item.id,
    run_number: (latest?.run_number ?? 0) + 1,
    generation: 1,
    state: "running",
    execution_kind: "attached",
    resolved_execution: input.resolvedExecution,
    admitted_at: context.now,
    started_at: context.now,
    session_id: binding.session_id,
    source_revision_refs: item.source_revision_refs ?? [],
    provenance: { actor: context.actor, operationId: input.operationId },
    row_version: 1,
    schema_version: 1,
    created_at: context.now,
    updated_at: context.now,
  })
  await ctx.db.patch(item._id, { state: "active", row_version: item.row_version + 1, updated_at: context.now })
  await ctx.db.patch(binding._id, {
    current_work_item_id: item.id,
    current_run_id: runId,
    provenance: { actor: context.actor, operationId: input.operationId },
    row_version: binding.row_version + 1,
    updated_at: context.now,
  })
  return {
    result: bindingDto(context.ownerUserId, await requireOwned(ctx, "workgraph_session_bindings", context, binding.id, "Session binding")),
    cursor: await appendActivityChange(
      ctx,
      context,
      input.operationId,
      binding.stream_id,
      "session_binding",
      binding.id,
      "session_task_attached",
      { bindingId: binding.id, workItemId: item.id, runId },
      true,
    ),
  }
}

async function recordAgentCheckpoint(ctx: any, context: ActivityContext, input: RecordAgentCheckpointInput) {
  const binding = await requireOwned(ctx, "workgraph_session_bindings", context, input.bindingId, "Session binding")
  if (binding.state !== "active" || !binding.current_work_item_id || !binding.current_run_id) {
    throw new WorkGraphSessionBindingError("invalid_transition", "Session binding has no active Work Item")
  }
  const run = await owned(ctx, "workgraph_runs", context.organizationId, context.ownerUserId, binding.current_run_id)
  if (!run || run.state !== "running" || run.execution_kind !== "attached" || run.session_id !== binding.session_id) {
    throw new WorkGraphSessionBindingError("invalid_transition", "Attached Run is not running in the bound Session")
  }
  const evidence = await Promise.all(input.evidenceIds.map((id) =>
    owned(ctx, "workgraph_evidence", context.organizationId, context.ownerUserId, id)))
  if (evidence.some((record) => !record || !(
    (record.subject_type === "work_item" && record.subject_id === binding.current_work_item_id) ||
    record.reference?.sourceRunId === binding.current_run_id
  ))) {
    throw new WorkGraphSessionBindingError("not_found", "Checkpoint evidence does not belong to the active Task")
  }
  const id = activityId("agent_checkpoint", context.ownerUserId, input.operationId)
  await ctx.db.insert("workgraph_agent_checkpoints", {
    organization_id: context.organizationId,
    owner_user_id: context.ownerUserId,
    id,
    stream_id: binding.stream_id,
    work_item_id: binding.current_work_item_id,
    run_id: binding.current_run_id,
    session_binding_id: binding.id,
    level: input.level,
    summary: input.summary,
    evidence_ids: input.evidenceIds,
    occurred_at: input.occurredAt ?? context.now,
    operation_id: input.operationId,
    provenance: { actor: context.actor, operationId: input.operationId },
    row_version: 1,
    schema_version: 1,
    created_at: context.now,
    updated_at: context.now,
  })
  return {
    result: checkpointDto(context.ownerUserId, await requireOwned(ctx, "workgraph_agent_checkpoints", context, id, "Agent checkpoint")),
    cursor: await appendActivityChange(
      ctx,
      context,
      input.operationId,
      binding.stream_id,
      "agent_checkpoint",
      id,
      "agent_checkpoint_recorded",
      { checkpointId: id, workItemId: binding.current_work_item_id, runId: binding.current_run_id },
    ),
  }
}

async function releaseSessionBinding(ctx: any, context: ActivityContext, input: ReleaseSessionBindingInput) {
  const binding = await requireOwned(ctx, "workgraph_session_bindings", context, input.bindingId, "Session binding")
  if (binding.state === "released") return { result: bindingDto(context.ownerUserId, binding) }
  if (binding.row_version !== input.expectedVersion) throw new WorkGraphSessionBindingError("conflict", "Session binding version changed")
  if (binding.current_run_id) {
    const run = await owned(ctx, "workgraph_runs", context.organizationId, context.ownerUserId, binding.current_run_id)
    if (!run || !["result", "failed", "cancelled"].includes(run.state)) {
      throw new WorkGraphSessionBindingError("invalid_transition", "Settle the attached Run before releasing its Session")
    }
  }
  await ctx.db.patch(binding._id, {
    state: "released",
    released_at: context.now,
    provenance: { actor: context.actor, operationId: input.operationId },
    row_version: binding.row_version + 1,
    updated_at: context.now,
  })
  return {
    result: bindingDto(context.ownerUserId, await requireOwned(ctx, "workgraph_session_bindings", context, binding.id, "Session binding")),
    cursor: await appendActivityChange(
      ctx,
      context,
      input.operationId,
      binding.stream_id,
      "session_binding",
      binding.id,
      "session_binding_released",
      { bindingId: binding.id },
    ),
  }
}

async function withOperation(
  ctx: any,
  context: ActivityContext,
  command: ParsedActivityCommand,
  run: () => Promise<Readonly<{ result: ActivityMutationResult; cursor?: number }>>,
): Promise<ActivityMutationResult> {
  const requestHash = await sha256(stableJson({ type: command.type, ...command.input }))
  const previous = await owned(ctx, "workgraph_operation_results", context.organizationId, context.ownerUserId, command.input.operationId)
  if (previous) {
    if (previous.command_type === command.type && previous.request_hash === requestHash && previous.result?.ok === true) {
      return activityResultWithOwner(previous.result.value, context.ownerUserId)
    }
    throw new WorkGraphSessionBindingError("conflict", "Operation ID already used")
  }
  const completed = await run()
  if (completed.cursor === undefined) return completed.result
  const result = {
    ok: true as const,
    operationId: command.input.operationId,
    cursor: createChangeCursor({
      organizationId: context.organizationId,
      ownerUserId: context.ownerUserId,
      position: completed.cursor,
    }),
    value: ownerNeutral(completed.result),
  }
  await ctx.db.insert("workgraph_operation_results", {
    organization_id: context.organizationId,
    owner_user_id: context.ownerUserId,
    id: command.input.operationId,
    command_type: command.type,
    request_hash: requestHash,
    result_status: 200,
    result,
    change_cursor: completed.cursor,
    schema_version: 1,
    created_at: context.now,
  })
  return completed.result
}

function parseActivityCommand(command: Record<string, unknown>): ParsedActivityCommand {
  if (command.type === "bind_session") return parsed("bind_session", BindSessionInputSchema, command)
  if (command.type === "attach_session_task") return parsed("attach_session_task", AttachSessionTaskInputSchema, command)
  if (command.type === "record_agent_checkpoint") return parsed("record_agent_checkpoint", RecordAgentCheckpointInputSchema, command)
  if (command.type === "release_session_binding") return parsed("release_session_binding", ReleaseSessionBindingInputSchema, command)
  throw new Error("Unsupported WorkGraph activity mutation")
}

function parsed<Type extends ParsedActivityCommand["type"]>(
  type: Type,
  schema: { safeParse: (value: unknown) => { success: true; data: Extract<ParsedActivityCommand, { type: Type }>["input"] } | { success: false } },
  command: Record<string, unknown>,
): Extract<ParsedActivityCommand, { type: Type }> {
  const input = schema.safeParse(Object.fromEntries(Object.entries(command).filter(([key]) => key !== "type")))
  if (!input.success) throw new Error(`Invalid ${type} mutation`)
  return { type, input: input.data } as Extract<ParsedActivityCommand, { type: Type }>
}

async function appendActivityChange(
  ctx: any,
  context: ActivityContext,
  operationId: string,
  streamId: string,
  resourceType: string,
  resourceId: string,
  changeType: string,
  payload: Record<string, unknown>,
  snapshotRelevant = false,
) {
  return appendOwnedWorkGraphChange(ctx, {
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    operationId,
    requestId: context.requestId,
    eventId: activityId("event", context.ownerUserId, operationId),
    changeId: activityId("change", context.ownerUserId, operationId),
    resourceType,
    resourceId,
    changeType,
    payload,
    actor: context.actor,
    streamId,
    snapshotRelevant,
    now: context.now,
  })
}

async function requireOwned(ctx: any, table: string, context: ActivityContext, id: string, label: string) {
  const record = await owned(ctx, table, context.organizationId, context.ownerUserId, id)
  if (!record) throw new WorkGraphSessionBindingError("not_found", `${label} not found`)
  return record
}

async function owned(ctx: any, table: string, organizationId: string, ownerUserId: string, id: string) {
  return ctx.db.query(table)
    .withIndex("by_tenant_id", (query: any) => query
      .eq("organization_id", organizationId)
      .eq("owner_user_id", ownerUserId)
      .eq("id", id))
    .unique()
}

function bindingDto(ownerUserId: string, row: any): SessionBindingDto {
  return SessionBindingDtoSchema.parse({
    recordType: "session_binding",
    schemaVersion: 1,
    ownerUserId,
    id: row.id,
    version: row.row_version,
    streamId: row.stream_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    ...(row.current_work_item_id ? { currentWorkItemId: row.current_work_item_id } : {}),
    ...(row.current_run_id ? { currentRunId: row.current_run_id } : {}),
    state: row.state,
    boundAt: row.bound_at,
    ...(row.released_at === undefined ? {} : { releasedAt: row.released_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provenance: row.provenance,
  })
}

function checkpointDto(ownerUserId: string, row: any): AgentCheckpointDto {
  return AgentCheckpointDtoSchema.parse({
    recordType: "agent_checkpoint",
    schemaVersion: 1,
    ownerUserId,
    id: row.id,
    version: row.row_version,
    streamId: row.stream_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    sessionBindingId: row.session_binding_id,
    level: row.level,
    summary: row.summary,
    evidenceIds: row.evidence_ids,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    provenance: row.provenance,
  })
}

function eventActivity(streamId: string, workItemId: string, change: any, event: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `event:${change.id}`,
    streamId,
    workItemId,
    category: "lifecycle",
    importance: change.change_type === "work_item_state_changed" ? "milestones"
      : change.change_type === "work_item_updated" ? "detailed"
        : "progress",
    summary: String(change.change_type).replaceAll("_", " "),
    occurredAt: change.created_at,
    actor: event ? { type: event.actor_type, id: event.actor_id } : { type: "system", id: "workgraph_runtime" },
    source: { type: "event", id: event?.id ?? change.event_id ?? change.id },
  })
}

function runActivity(streamId: string, workItemId: string, run: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `run:${run.id}:${run.state}`,
    streamId,
    workItemId,
    category: "run",
    importance: ["result", "failed", "cancelled"].includes(run.state) ? "milestones" : "progress",
    summary: `Run ${run.run_number} ${run.state}`,
    occurredAt: run.updated_at,
    actor: { type: "system", id: "workgraph_runtime" },
    source: { type: "run", id: run.id },
  })
}

function checkpointActivity(streamId: string, workItemId: string, checkpoint: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `checkpoint:${checkpoint.id}`,
    streamId,
    workItemId,
    category: "checkpoint",
    importance: checkpoint.level === "milestone" ? "milestones" : checkpoint.level === "detail" ? "detailed" : "progress",
    summary: checkpoint.summary,
    occurredAt: checkpoint.occurred_at,
    actor: checkpoint.provenance.actor,
    source: { type: "checkpoint", id: checkpoint.id },
  })
}

function decisionActivity(streamId: string, workItemId: string, decision: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `decision:${decision.id}`,
    streamId,
    workItemId,
    category: "decision",
    importance: "milestones",
    summary: decision.question,
    occurredAt: decision.updated_at,
    actor: decision.provenance?.actor ?? { type: "agent", id: "workgraph_agent" },
    source: { type: "decision", id: decision.id },
  })
}

function evidenceActivity(streamId: string, workItemId: string, evidence: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `evidence:${evidence.id}`,
    streamId,
    workItemId,
    category: evidence.evidence_kind === "integration" ? "external_effect" : "evidence",
    importance: "milestones",
    summary: evidence.summary,
    occurredAt: evidence.created_at,
    actor: evidence.provenance?.actor ?? { type: "agent", id: "workgraph_agent" },
    source: { type: "evidence", id: evidence.id },
  })
}

function receiptActivity(streamId: string, workItemId: string, receipt: any): TaskActivityEntry {
  return TaskActivityEntrySchema.parse({
    id: `external_effect:${receipt.id}`,
    streamId,
    workItemId,
    category: "external_effect",
    importance: "milestones",
    summary: receipt.effect_kind,
    occurredAt: receipt.created_at,
    actor: receipt.provenance?.actor ?? { type: "system", id: "workgraph_runtime" },
    source: { type: "external_effect", id: receipt.id },
  })
}

function beforeCursor(
  query: any,
  timeField: string,
  idField: string,
  sourcePrefix: string,
  cursor?: Readonly<{ occurredAt: number; entryId: string }>,
) {
  if (!cursor) return query
  const { prefix, sourceId } = activityCursorPosition(cursor.entryId)
  if (sourcePrefix !== prefix) return query
  return query.filter((filter: any) => filter.or(
    filter.lt(filter.field(timeField), cursor.occurredAt),
    filter.and(
      filter.eq(filter.field(timeField), cursor.occurredAt),
      filter.lt(filter.field(idField), sourceId),
    ),
  ))
}

function filterActivitySource(
  query: any,
  source: "event" | "run" | "checkpoint",
  granularity: StreamActivityGranularity,
) {
  if (granularity === "detailed") return query
  if (source === "event") {
    return query.filter((filter: any) => granularity === "milestones"
      ? filter.eq(filter.field("change_type"), "work_item_state_changed")
      : filter.neq(filter.field("change_type"), "work_item_updated"))
  }
  if (source === "run") {
    if (granularity === "progress") return query
    return query.filter((filter: any) => filter.or(
      filter.eq(filter.field("state"), "result"),
      filter.eq(filter.field("state"), "failed"),
      filter.eq(filter.field("state"), "cancelled"),
    ))
  }
  return query.filter((filter: any) => granularity === "milestones"
    ? filter.eq(filter.field("level"), "milestone")
    : filter.neq(filter.field("level"), "detail"))
}

function activityIndexRange(
  query: any,
  timeField: string,
  sourcePrefix: string,
  cursor?: Readonly<{ occurredAt: number; entryId: string }>,
) {
  if (!cursor) return query
  const comparison = sourcePrefix.localeCompare(activityCursorPosition(cursor.entryId).prefix)
  if (comparison < 0) return query.lte(timeField, cursor.occurredAt)
  if (comparison > 0) return query.lt(timeField, cursor.occurredAt)
  return query.lte(timeField, cursor.occurredAt)
}

function atOrBeforeIndexTime(query: any, timeField: string, cursor?: Readonly<{ occurredAt: number }>) {
  return cursor ? query.lte(timeField, cursor.occurredAt) : query
}

function activityCursorPosition(entryId: string) {
  const separator = entryId.indexOf(":")
  return {
    prefix: separator === -1 ? entryId : entryId.slice(0, separator),
    sourceId: separator === -1 ? entryId : entryId.slice(separator + 1).split(":")[0]!,
  }
}

function atOrBeforeCursorTime(
  query: any,
  timeField: string,
  cursor?: Readonly<{ occurredAt: number }>,
) {
  if (!cursor) return query
  return query.filter((filter: any) => filter.or(
    filter.lt(filter.field(timeField), cursor.occurredAt),
    filter.eq(filter.field(timeField), cursor.occurredAt),
  ))
}

function beforePosition(occurredAt: number, id: string, cursor?: Readonly<{ occurredAt: number; entryId: string }>) {
  if (!cursor) return true
  return occurredAt < cursor.occurredAt || (occurredAt === cursor.occurredAt && id < cursor.entryId)
}

function compareActivityPosition(leftTime: number, leftId: string, rightTime: number, rightId: string) {
  return leftTime - rightTime || leftId.localeCompare(rightId)
}

function allowedImportance(granularity: StreamActivityGranularity) {
  if (granularity === "milestones") return new Set(["milestones"])
  if (granularity === "progress") return new Set(["milestones", "progress"])
  return new Set(["milestones", "progress", "detailed"])
}

function activityId(kind: string, ownerUserId: string, operationId: string) {
  return `${kind}_${ownerUserId}_${operationId}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
  return JSON.stringify(value)
}

function ownerNeutral(value: ActivityMutationResult) {
  const { ownerUserId: _ownerUserId, ...result } = value
  return result
}

function activityResultWithOwner(value: unknown, ownerUserId: string): ActivityMutationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkGraphSessionBindingError("conflict", "Stored activity operation result is invalid")
  }
  if ("recordType" in value && value.recordType === "agent_checkpoint") {
    return AgentCheckpointDtoSchema.parse({ ...value, ownerUserId })
  }
  return SessionBindingDtoSchema.parse({ ...value, ownerUserId })
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
