import { v } from "convex/values"
import type { GenericMutationCtx } from "convex/server"
import { AdmissionAgentPlanSchema, AdmissionProposalGenerationSchema, AuthoringSourceRevisionSchema, MASTER_DAILY_SCHEDULE, masterSessionId, PublicEventPayloadSchema, UpdateStreamNotesCommandSchema, WorkGraphCommandSchema, WorkSourceOriginSchema, createChangeCursor, nextDailyMasterRun, workGraphMasterLaneKey, workGraphMasterLaneWorkspace, type ChangeCursor } from "@claxedo/workgraph/contracts"
import { rankDuplicateMatches, rankStreamMatches } from "@claxedo/workgraph/matching"
import {
  dependencyGraphHasCycle,
  carveExecutionBudget,
  evaluateCompletionContract,
  renderStreamNotes,
  resolveExecutionProfile,
  validateExecutionProfileDefaultsAgainstCapabilities,
  validateResolvedExecutionProfileAgainstCapabilities,
} from "@claxedo/workgraph/domain"
import { ExecutionCapabilitiesSchema, ExecutionProfileDefaultsSchema, isExecutionCapabilityCatalogFresh, resolvedPlacement } from "@claxedo/workgraph/contracts"
import { authedMutation, serviceMutation } from "./model"
import { requireOwnedWorkGraphContext, requireTrustedWorkGraphTenantSubject, workGraphOwnerDeletionBarrier } from "./workgraphModel"
import { initializeAttentionProjection, removeAttentionRecord, syncAttentionRecord, syncAttentionResource, syncCandidateTransition } from "./workgraphAttention"
import { createLaneWakeIfIdle, createWakeInTx } from "./wakes"
import type { DataModel, Doc, Id } from "./_generated/dataModel"

const ROOT_ID = "workgraph_default"
const OWNER_EVENT_SEQUENCE = "__workgraph_owner__"
const supported = new Set([
  "update_workgraph_defaults",
  "create_work_source",
  "revise_work_source",
  "create_stream",
  "update_stream",
  "set_stream_charter",
  "call_master",
  "record_landing_conflict",
  "update_stream_notes",
  "request_public_pr_confirmation",
  "confirm_public_pr",
  "record_master_audit",
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
  "record_run_checkpoint",
  "complete_run",
  "record_evidence",
  "close_outcome",
  "reopen_outcome",
  "close_stream",
  "delete_stream",
  "approve_work_item",
  "reject_work_item",
  "approve_work_items",
  "arm_work_item",
  "arm_work_items",
  "cancel_run",
  "restart_run",
  "retry_work_item",
])
const SUBTASK_SEAT_FORBIDDEN_COMMANDS = new Set([
  "create_work_item",
  "propose_admission",
  "propose_decision",
])

const interactiveArgs = {
  organization_id: v.id("orgs"),
  operation_id: v.string(),
  request_id: v.string(),
  command: v.any(),
}

const serviceArgs = {
  ...interactiveArgs,
  owner_subject: v.string(),
  actor_type: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
  actor_id: v.string(),
}

export const execute = authedMutation({
  args: interactiveArgs,
  handler: async (ctx, args) => {
    const owned = await requireOwnedWorkGraphContext(ctx)
    const membership = await ctx.db.query("org_memberships")
      .withIndex("by_org_user", (query: any) => query.eq("org_id", args.organization_id).eq("user_id", owned.owner_user_id))
      .unique()
    if (!membership) throw new Error("WorkGraph organization membership is required")
    return applyWorkGraphCommand(ctx, {
      organizationId: String(args.organization_id),
      ownerUserId: owned.owner_user_id,
      ownerSubject: owned.user.clerk_subject ?? String(owned.owner_user_id),
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
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    const ownerUserId = String(tenant.owner_user_id)
    return applyWorkGraphCommand(ctx, {
      organizationId: String(tenant.organization_id),
      ownerUserId,
      ownerSubject: args.owner_subject,
      // A service-attested "user" actor is ALWAYS the authenticated tenant
      // owner (the exact identity the interactive mutation would build): the
      // trusted control plane already verified the subject's signed token, and
      // forcing the id here removes any impersonation surface. Without this,
      // the hosted Worker's command path had to downgrade users to "agent",
      // which sent every user-created Task through the approval gate
      // (`pending_approval`) and starved the continuous execution drain.
      actor: args.actor_type === "user"
        ? { type: "user", id: ownerUserId }
        : { type: args.actor_type, id: args.actor_id },
      requestId: args.request_id,
      operationId: args.operation_id,
      command: args.command,
    })
  },
})

export const readStreamVersionForService = serviceMutation({
  args: {
    service_token: v.string(),
    organization_id: v.id("orgs"),
    owner_subject: v.string(),
    stream_id: v.string(),
  },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    const stream = await owned(ctx, "workgraph_streams", String(tenant.organization_id), String(tenant.owner_user_id), args.stream_id)
    return stream ? { version: stream.row_version } : {}
  },
})

type CommandInput = {
  organizationId: string
  ownerUserId: string
  ownerSubject: string
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
  if (await workGraphOwnerDeletionBarrier(ctx, input.organizationId, input.ownerUserId)) {
    return failure(input.operationId, "blocked", "WorkGraph owner deletion is in progress")
  }

  const now = Date.now()
  const capabilityFailure = await validateCommandCapabilities(ctx, input, now)
  if (capabilityFailure) return failure(input.operationId, capabilityFailure.code, capabilityFailure.message)

  const requestHash = await sha256(stableJson(input.command))
  const previous = await ctx.db
    .query("workgraph_operation_results")
    .withIndex("by_tenant_id", (q: any) => q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("id", input.operationId))
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .unique()
  if (previous?.request_hash === requestHash) return previous.result
  if (previous) return failure(input.operationId, "idempotency_conflict", "Operation ID already used")

  await ensureOwnerRoot(ctx, input, now)
  const pending = await applyCommand(ctx, input, now)
  if (!pending.ok) {
    await saveOperation(ctx, input, requestHash, pending.result, now)
    return pending.result
  }

  if (pending.streamId) {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, pending.streamId)
    if (stream) {
      await ctx.db.patch(stream._id, {
        activity: { lastActivityAt: now },
        last_activity_at: now,
        updated_at: now,
      })
    }
  }

  await syncCommandAttention(ctx, input.organizationId, input.ownerUserId, pending)

  const sequenceScope = pending.streamId ?? OWNER_EVENT_SEQUENCE
  const sequence = await allocateSequence(ctx, input.organizationId, input.ownerUserId, sequenceScope, now)
  const payload = { ...pending.value, ...(pending.streamId ? { streamId: pending.streamId } : {}) }
  await ctx.db.insert("workgraph_events", {
    organization_id: input.organizationId,
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
  const watermark = await appendChange(ctx, {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: `${resourceId("change", input)}_${sequence}`,
    cursor: sequence,
    ...(pending.streamId ? { stream_id: pending.streamId } : {}),
    operation_id: input.operationId,
    event_id: resourceId("event", input),
    resource_type: pending.resourceType,
    resource_id: pending.resourceId,
    change_type: pending.type,
    payload,
    snapshot_relevant: true,
    schema_version: 1,
    created_at: now,
  })
  const result = success(input.operationId, createChangeCursor({
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    position: watermark,
  }), pending.value)
  await saveOperation(ctx, input, requestHash, result, now, sequence)
  await markWorkGraphTenantDirty(ctx, input.organizationId, input.ownerUserId, input.operationId, now)
  return result
}

async function applyCommand(ctx: any, input: CommandInput, now: number): Promise<any> {
  const command = input.command
  if (input.actor.type === "agent" && SUBTASK_SEAT_FORBIDDEN_COMMANDS.has(command.type)) {
    const binding = await ctx.db
      .query("workgraph_session_bindings")
      .withIndex("by_tenant_session", (query: any) =>
        query
          .eq("organization_id", input.organizationId)
          .eq("owner_user_id", input.ownerUserId)
          .eq("session_id", input.actor.id),
      )
      .filter((query: any) => query.eq(query.field("state"), "active"))
      .first()
    const run = binding?.current_run_id
      ? await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, binding.current_run_id)
      : undefined
    const item = run
      ? await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, run.work_item_id)
      : undefined
    if (item?.parent_task_id) {
      return rejected(
        input.operationId,
        "forbidden_for_subtask",
        "Subtask execution seats cannot create or propose work",
      )
    }
  }
  if (command.type === "update_workgraph_defaults") {
    const root = await owned(ctx, "workgraphs", input.organizationId, input.ownerUserId, ROOT_ID)
    if (!root) return rejected(input.operationId, "not_found", "WorkGraph defaults not found")
    if (root.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "WorkGraph defaults version changed")
    await ctx.db.patch(root._id, {
      defaults: command.defaults.execution,
      row_version: root.row_version + 1,
      provenance: { actor: { type: input.actor.type, id: input.actor.id }, operationId: input.operationId },
      updated_at: now,
    })
    return pending("workgraph_defaults_updated", "workgraph", ROOT_ID, { workGraphId: ROOT_ID })
  }
  if (command.type === "approve_work_item") {
    // Approval is owner-only: agents can never approve, reject, or launch (plan
    // §4). CAS on row_version AND state to close the approve-vs-edit /
    // approve-vs-delete races — 0 rows affected is a conflict, never silent success.
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can approve tasks")
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (item.state !== "pending_approval")
      return rejected(input.operationId, "invalid_transition", "Task is not awaiting approval")
    await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: now })
    // Approval is a readiness-changing mutation: drain in-transaction so an
    // approved+ready task in an active Stream launches with no further action
    // (the hosted nudge and CF cron are the durability backstops, §5.2 row 1).
    const approvedStream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
    if (approvedStream) await continueStream(ctx, approvedStream, now)
    return pending(
      "work_item_approved",
      "work_item",
      command.workItemId,
      { workItemId: command.workItemId, version: item.row_version + 1 },
      item.stream_id,
    )
  }
  if (command.type === "reject_work_item") {
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can reject tasks")
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (item.state !== "pending_approval")
      return rejected(input.operationId, "invalid_transition", "Task is not awaiting approval")
    // Reject -> the existing terminal `abandoned`. Abandoned satisfies dependencies
    // (see readiness change) so rejecting a task unblocks its dependents.
    await ctx.db.patch(item._id, {
      state: "abandoned",
      abandon_reason: command.reason,
      abandoned_at: now,
      row_version: item.row_version + 1,
      updated_at: now,
    })
    // Rejection unblocks dependents (abandoned satisfies dependencies), so it is
    // readiness-changing too: drain in-transaction.
    const rejectedStream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
    if (rejectedStream) await continueStream(ctx, rejectedStream, now)
    return pending(
      "work_item_rejected",
      "work_item",
      command.workItemId,
      { workItemId: command.workItemId, reason: command.reason },
      item.stream_id,
    )
  }
  if (command.type === "approve_work_items") {
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can approve tasks")
    // Per-entry CAS `pending_approval -> pending`. Partial success by design: one
    // stale or missing task never blocks the rest. The client sends the exact
    // row_versions it rendered so it never approves an unseen edit; a server-side
    // "approve everything staged" sweep is forbidden.
    const results = []
    const approvedStreams = new Set<string>()
    for (const approval of command.approvals) {
      const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, approval.workItemId)
      if (!item) {
        results.push({ workItemId: approval.workItemId, outcome: "not_found" as const })
        continue
      }
      if (item.row_version !== approval.expectedVersion) {
        results.push({ workItemId: approval.workItemId, outcome: "version_conflict" as const })
        continue
      }
      if (item.state !== "pending_approval") {
        results.push({ workItemId: approval.workItemId, outcome: "not_staged" as const })
        continue
      }
      await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: now })
      approvedStreams.add(item.stream_id)
      results.push({ workItemId: approval.workItemId, outcome: "approved" as const, version: item.row_version + 1 })
    }
    for (const streamId of approvedStreams) {
      const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, streamId)
      if (stream) await continueStream(ctx, stream, now)
    }
    return pending("work_item_approved", "workgraph", ROOT_ID, { results })
  }
  if (command.type === "arm_work_item") {
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can arm draft tasks")
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (item.state !== "draft")
      return rejected(input.operationId, "invalid_transition", "Task is not a draft")
    await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: now })
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
    if (stream) await continueStream(ctx, stream, now)
    return pending("work_item_armed", "work_item", item.id, { workItemId: item.id }, item.stream_id)
  }
  if (command.type === "arm_work_items") {
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can arm draft tasks")
    const results = []
    const streams = new Set<string>()
    for (const entry of command.items) {
      const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, entry.workItemId)
      if (!item) {
        results.push({ workItemId: entry.workItemId, outcome: "not_found" as const })
        continue
      }
      if (item.row_version !== entry.expectedVersion) {
        results.push({ workItemId: entry.workItemId, outcome: "version_conflict" as const })
        continue
      }
      if (item.state !== "draft") {
        results.push({ workItemId: entry.workItemId, outcome: "not_draft" as const })
        continue
      }
      await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: now })
      streams.add(item.stream_id)
      results.push({ workItemId: entry.workItemId, outcome: "armed" as const, version: item.row_version + 1 })
    }
    for (const streamId of streams) {
      const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, streamId)
      if (stream) await continueStream(ctx, stream, now)
    }
    return pending("work_item_armed", "workgraph", ROOT_ID, { results })
  }
  if (command.type === "retry_work_item") {
    // Pure CAS-guarded `failed -> pending` flip. Approval is preserved by
    // construction (the retry edge never passes through `pending_approval`); no
    // stored execution mode is replayed. The drain re-admits the item once the
    // Stream is active and its derived hold clears.
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (item.state !== "failed")
      return rejected(input.operationId, "invalid_transition", "Only a failed Work Item can be retried")
    await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: now })
    const retriedStream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
    if (retriedStream) await continueStream(ctx, retriedStream, now)
    return pending(
      "work_item_state_changed",
      "work_item",
      command.workItemId,
      { workItemId: command.workItemId, state: "pending" },
      item.stream_id,
    )
  }
  if (command.type === "restart_run") {
    if (input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can restart a parked Run")
    const run = await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, command.runId)
    if (!run) return rejected(input.operationId, "not_found", "Run not found")
    if (run.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Run version changed")
    if (run.state !== "parked")
      return rejected(input.operationId, "invalid_transition", "Only a parked Run can be restarted")
    await ctx.db.patch(run._id, {
      cancellation: { state: "pending", requestedAt: now, reason: command.reason },
      parked_reason: `Restart requested: ${command.reason}`,
      row_version: run.row_version + 1,
      updated_at: now,
    })
    await enqueueControlEffect(ctx, input, now, {
      effectType: "interrupt_run",
      streamId: run.stream_id,
      idempotencyKey: `${run.id}:restart`,
      payload: {
        finalize: "restart",
        runId: run.id,
        reason: command.reason,
        ...(run.session_id ? { sessionId: run.session_id } : {}),
      },
    })
    const outbox = await runLaunchOutbox(ctx, input.organizationId, input.ownerUserId, run.id)
    if (outbox)
      await ctx.db.patch(outbox._id, {
        status: "cancelled",
        last_error: `Restarted: ${command.reason}`,
        claimed_by: undefined,
        claim_expires_at: undefined,
        updated_at: now,
      })
    return pending(
      "run_cancellation_requested",
      "run",
      run.id,
      { runId: run.id, workItemId: run.work_item_id, reason: command.reason },
      run.stream_id,
    )
  }
  if (command.type === "cancel_run") {
    const run = await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, command.runId)
    if (!run) return rejected(input.operationId, "not_found", "Run not found")
    if (run.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Run version changed")
    if (["result", "failed", "cancelled"].includes(run.state))
      return rejected(input.operationId, "invalid_transition", "Run is already terminal")
    await ctx.db.patch(run._id, {
      cancellation: { state: "pending", requestedAt: now, reason: command.reason },
      parked_reason: `Cancellation requested: ${command.reason}`,
      row_version: run.row_version + 1,
      updated_at: now,
    })
    await enqueueControlEffect(ctx, input, now, {
      effectType: "interrupt_run",
      streamId: run.stream_id,
      idempotencyKey: `${run.id}:interrupt`,
      payload: {
        finalize: "cancel",
        runId: run.id,
        ...(run.session_id ? { sessionId: run.session_id } : {}),
      },
    })
    const outbox = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant_idempotency", (q: any) =>
        q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("idempotency_key", `${run.id}:launch`),
      )
      .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
      .unique()
    if (outbox && outbox.status === "pending") await ctx.db.patch(outbox._id, { status: "cancelled", updated_at: now })
    return pending(
      "run_cancellation_requested",
      "run",
      run.id,
      { runId: run.id },
      run.stream_id,
    )
  }
  if (command.type === "create_stream") {
    const parent = command.parentStreamId
      ? await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.parentStreamId)
      : undefined
    if (command.parentStreamId && !parent)
      return rejected(input.operationId, "not_found", "Parent Stream not found")
    if (parent && input.actor.type === "agent" && parent.execution_defaults?.mayPromote !== true)
      return rejected(input.operationId, "forbidden", "Parent Stream does not allow child promotion")
    const existingChildren = parent
      ? await ctx.db
          .query("workgraph_streams")
          .withIndex("by_tenant_parent", (query: any) =>
            query
              .eq("organization_id", input.organizationId)
              .eq("owner_user_id", input.ownerUserId)
              .eq("parent_stream_id", parent.id),
          )
          .take(1)
      : []
    if (
      parent &&
      existingChildren.length === 0 &&
      (input.actor.type !== "user" || command.confirmAutonomy !== true)
    ) {
      return rejected(
        input.operationId,
        "promotion_confirmation_required",
        "The first child Stream requires explicit owner confirmation",
      )
    }
    if (command.execution?.autonomy === "autonomous" && (input.actor.type !== "user" || command.confirmAutonomy !== true))
      return rejected(input.operationId, "autonomy_confirmation_required", "Autonomous Streams require explicit owner confirmation")
    if (command.execution?.budget && input.actor.type !== "user")
      return rejected(input.operationId, "forbidden", "Only the owner can configure a Stream budget")
    if (command.charter && command.charter.hash.toLowerCase() !== await sha256(command.charter.text))
      return rejected(input.operationId, "validation_error", "Stream charter text does not match its declared hash")
    if (command.source && !(await exactSourceRevision(ctx, input.organizationId, input.ownerUserId, command.source))) {
      return rejected(input.operationId, "version_conflict", "Stream source is not the current Work Source head")
    }
    const carved = parent
      ? carveExecutionBudget(parent.execution_defaults ?? {}, command.execution, command.budgetCarve)
      : undefined
    if (carved && !carved.ok) {
      return rejected(
        input.operationId,
        "validation_error",
        {
          parent_budget_required: "Parent Stream has no budget to carve",
          budget_shape_mismatch: "Child budget carve must use the parent budget unit and window",
          insufficient_parent_budget: "Child budget carve must leave a positive parent budget",
        }[carved.error],
      )
    }
    const root = await owned(ctx, "workgraphs", input.organizationId, input.ownerUserId, ROOT_ID)
    const profileCheck = resolveExecutionProfile({
      workgraph: root?.defaults ?? {},
      stream: carved?.child ?? command.execution ?? {},
    })
    if (!profileCheck.ok && profileCheck.error.code === "unknown_agent_profile")
      return rejected(
        input.operationId,
        "unknown_agent_profile",
        `Unknown agent profile: ${profileCheck.error.profileName}`,
      )
    const id = resourceId("stream", input)
    if (parent && carved && command.budgetCarve) {
      await ctx.db.patch(parent._id, {
        execution_defaults: carved.parent,
        row_version: parent.row_version + 1,
        updated_at: now,
      })
    }
    await ctx.db.insert("workgraph_streams", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id,
      workgraph_id: ROOT_ID,
      ...(command.parentStreamId === undefined ? {} : { parent_stream_id: command.parentStreamId }),
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.charter === undefined ? {} : { charter: command.charter }),
      lifecycle_state: "active",
      visibility: "visible",
      pinned: false,
      execution_defaults: carved?.child ?? command.execution ?? {},
      activity_granularity: command.activityGranularity ?? "progress",
      activity: { lastActivityAt: now },
      durable_effect_count: 0,
      source_revision_refs: command.source ? [sourceRef(command.source)] : [],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await enqueueMasterSchedule(ctx, input.organizationId, input.ownerUserId, id, now, input.actor.id)
    return pending("stream_created", "stream", id, { streamId: id }, id)
  }
  if (command.type === "update_stream") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    const executionError = streamExecutionChangeError(
      stream.execution_defaults,
      command.execution,
      input.actor.type,
      command.confirmAutonomy,
    )
    if (executionError) return rejected(input.operationId, executionError.code, executionError.message)
    await ctx.db.patch(stream._id, {
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.description === undefined ? {} : { description: command.description }),
      ...(command.execution === undefined ? {} : { execution_defaults: command.execution }),
      ...(command.activityGranularity === undefined ? {} : { activity_granularity: command.activityGranularity }),
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    return pending("stream_updated", "stream", stream.id, { streamId: stream.id }, stream.id)
  }
  if (command.type === "set_stream_charter") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (command.charter.hash.toLowerCase() !== await sha256(command.charter.text))
      return rejected(input.operationId, "validation_error", "Stream charter text does not match its declared hash")
    // Budget is the load-bearing safety rail for autonomous Streams (plan
    // 2026-07-28-003): owner confirmation gates ENTERING autonomy, but only a
    // budget bounds what a COMPILED autonomous charter can spend once running.
    // Must stay in lockstep with the sqlite adapter's copy — this Convex
    // mutation is reachable directly through the public SDK, so it is the real
    // boundary, not the Worker route in front of it.
    if (command.compiled?.autonomy === "autonomous" && !command.compiled.budget)
      return rejected(input.operationId, "validation_error", "Autonomous compiled charters require a budget")
    const executionError = streamExecutionChangeError(
      stream.execution_defaults,
      command.compiled,
      input.actor.type,
      command.confirmAutonomy,
    )
    if (executionError) return rejected(input.operationId, executionError.code, executionError.message)
    await ctx.db.patch(stream._id, {
      charter: command.charter,
      ...(command.compiled === undefined ? {} : { execution_defaults: command.compiled }),
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    return pending(
      "stream_charter_updated",
      "stream",
      stream.id,
      { streamId: stream.id, charterHash: command.charter.hash },
      stream.id,
    )
  }
  if (command.type === "call_master") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (stream.lifecycle_state === "closed")
      return rejected(input.operationId, "invalid_transition", "Closed Streams cannot receive master messages")
    const messageId = resourceId("master_message", input)
    await ctx.db.insert("workgraph_master_mailbox", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      stream_id: stream.id,
      id: messageId,
      message: command.message,
      provenance: provenance(input),
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    // An owner message to a halted ('attention') master is the explicit
    // resume: it clears the escalation and the failure counter. Agent
    // messages park in the mailbox and never un-halt an escalated master.
    if (input.actor.type === "user" && stream.master_status?.state === "attention") {
      // Explicit fields only: the halted turn is dead, so its turnId and
      // admission fence must not leak into the resumed status.
      const resumed = {
        state: "hibernating",
        ...(typeof stream.master_status.sessionId === "string" ? { sessionId: stream.master_status.sessionId } : {}),
        failureCount: 0,
        message: "Owner resumed the master",
        receiptRefs: stream.master_status.receiptRefs ?? [],
        ...(typeof stream.charter?.hash === "string" ? { charterHash: stream.charter.hash } : {}),
        updatedAt: now,
      }
      await ctx.db.patch(stream._id, { master_status: resumed, updated_at: now })
      await syncAttentionRecord(ctx, "workgraph_streams", { ...stream, master_status: resumed, updated_at: now })
    }
    await enqueueMasterWake(ctx, input.organizationId, input.ownerUserId, stream.id, now, "mailbox", input.actor.id)
    return pending(
      "master_called",
      "stream",
      stream.id,
      { streamId: stream.id, mailboxMessageId: messageId },
      stream.id,
    )
  }
  if (command.type === "record_landing_conflict") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (input.actor.type !== "agent" || input.actor.id !== masterSessionId(stream.id))
      return rejected(input.operationId, "forbidden", "Only the Stream master can record landing conflicts")
    const item = await owned(
      ctx,
      "workgraph_work_items",
      input.organizationId,
      input.ownerUserId,
      command.workItemId,
    )
    if (!item || item.stream_id !== stream.id)
      return rejected(input.operationId, "not_found", "Work Item not found")
    if (!["result_ready", "review_needed", "integration_needed"].includes(item.state))
      return rejected(input.operationId, "invalid_transition", "Only completed candidate work can require integration")
    const messageId = resourceId("master_message", input)
    await ctx.db.patch(item._id, {
      state: "integration_needed",
      row_version: item.row_version + 1,
      updated_at: now,
    })
    await ctx.db.insert("workgraph_master_mailbox", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      stream_id: stream.id,
      id: messageId,
      message: `Landing conflict for ${item.title} (${item.id}): ${command.reason}`,
      provenance: provenance(input),
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    await syncAttentionResource(ctx, input.organizationId, input.ownerUserId, "workgraph_work_items", item.id)
    await enqueueMasterWake(ctx, input.organizationId, input.ownerUserId, stream.id, now, "mailbox", input.actor.id)
    return pending(
      "work_item_state_changed",
      "work_item",
      item.id,
      { workItemId: item.id, state: "integration_needed", reason: command.reason, mailboxMessageId: messageId },
      stream.id,
    )
  }
  if (command.type === "update_stream_notes") {
    const notes = UpdateStreamNotesCommandSchema.parse(command)
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, notes.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== notes.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (input.actor.type !== "agent" || input.actor.id !== masterSessionId(stream.id))
      return rejected(input.operationId, "forbidden", "Only the Stream master can update Stream notes")
    const references = await Promise.all(notes.externalReferences.map(async (reference) => {
      const revision = await owned(
        ctx,
        "work_source_revisions",
        input.organizationId,
        input.ownerUserId,
        reference.source.revisionId,
      )
      return revision &&
        revision.work_source_id === reference.source.workSourceId &&
        revision.content_hash === reference.source.contentHash &&
        revision.origin?.kind === "external"
    }))
    if (references.some((valid) => !valid)) {
      return rejected(
        input.operationId,
        "validation_error",
        "Stream notes external references require exact externally-originated Work Source revisions",
      )
    }
    const content = renderStreamNotes(notes)
    const contentHash = await sha256(content)
    const sourceId = stream.notes_source?.work_source_id ?? resourceId("source", input)
    const revisionId = resourceId("revision", input)
    if (stream.notes_source) {
      const source = await owned(ctx, "work_sources", input.organizationId, input.ownerUserId, sourceId)
      if (!source) return rejected(input.operationId, "not_found", "Stream notes Work Source not found")
      await ctx.db.insert("work_source_revisions", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: revisionId,
        work_source_id: sourceId,
        revision_number: source.latest_revision_number + 1,
        content,
        content_hash: contentHash,
        origin: { kind: "manual", ...(notes.externalReferences.length ? { derivedFromExternal: true } : {}) },
        created_by: input.actor,
        schema_version: 1,
        created_at: now,
      })
      await ctx.db.patch(source._id, {
        latest_revision_id: revisionId,
        latest_revision_number: source.latest_revision_number + 1,
        row_version: source.row_version + 1,
        updated_at: now,
      })
    } else {
      await ctx.db.insert("work_sources", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: sourceId,
        workgraph_id: ROOT_ID,
        title: `Notes · ${stream.title}`,
        source_kind: "manual",
        metadata: { kind: "stream_notes", streamId: stream.id },
        latest_revision_id: revisionId,
        latest_revision_number: 1,
        row_version: 1,
        schema_version: 1,
        created_at: now,
        updated_at: now,
      })
      await ctx.db.insert("work_source_revisions", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: revisionId,
        work_source_id: sourceId,
        revision_number: 1,
        content,
        content_hash: contentHash,
        origin: { kind: "manual", ...(notes.externalReferences.length ? { derivedFromExternal: true } : {}) },
        created_by: input.actor,
        schema_version: 1,
        created_at: now,
      })
    }
    const notesSource = { work_source_id: sourceId, revision_id: revisionId, content_hash: contentHash }
    await ctx.db.patch(stream._id, { notes_source: notesSource, row_version: stream.row_version + 1, updated_at: now })
    return pending(
      "stream_notes_updated",
      "stream",
      stream.id,
      { streamId: stream.id, notesSource: { workSourceId: sourceId, revisionId, contentHash } },
      stream.id,
    )
  }
  if (command.type === "request_public_pr_confirmation") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(input.operationId, "version_conflict", "Stream version changed")
    const sessionId = masterSessionId(stream.id)
    if (input.actor.type !== "agent" || input.actor.id !== sessionId)
      return rejected(input.operationId, "forbidden", "Only the Stream master can request public PR confirmation")
    if (stream.public_pr_confirmed_at !== undefined) {
      return pending("public_pr_confirmed", "stream", stream.id, { streamId: stream.id, alreadyConfirmed: true }, stream.id)
    }
    // Idempotent: a confirmation already awaiting the owner is a success
    // no-op — retries must not rewrite the escalation or conflict.
    if (stream.master_status?.state === "attention" && stream.master_status?.escalation === "public_pr_confirmation") {
      return pending("public_pr_confirmation_requested", "stream", stream.id, { streamId: stream.id, repository: command.repository, title: command.title, alreadyPending: true }, stream.id)
    }
    const reason = `Confirm the first non-draft pull request to public repository ${command.repository}: ${command.title}`
    const masterStatus = { state: "attention", escalation: "public_pr_confirmation", sessionId, message: reason, receiptRefs: [], updatedAt: now }
    await ctx.db.patch(stream._id, { master_status: masterStatus, updated_at: now })
    await syncAttentionRecord(ctx, "workgraph_streams", { ...stream, master_status: masterStatus, updated_at: now })
    return pending("public_pr_confirmation_requested", "stream", stream.id, { streamId: stream.id, repository: command.repository, title: command.title }, stream.id)
  }
  if (command.type === "confirm_public_pr") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion) return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (input.actor.type !== "user") return rejected(input.operationId, "forbidden", "Public PR confirmation requires the owner")
    const masterStatus = { state: "hibernating", sessionId: masterSessionId(stream.id), message: "Public PR action confirmed", receiptRefs: [], updatedAt: now }
    const saved = { ...stream, public_pr_confirmed_at: now, master_status: masterStatus, row_version: stream.row_version + 1, updated_at: now }
    await ctx.db.patch(stream._id, saved)
    await syncAttentionRecord(ctx, "workgraph_streams", saved)
    await enqueueMasterWake(ctx, input.organizationId, input.ownerUserId, stream.id, now, "mailbox")
    return pending("public_pr_confirmed", "stream", stream.id, { streamId: stream.id, confirmedAt: now }, stream.id)
  }
  if (command.type === "record_master_audit") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (input.actor.type !== "agent" || input.actor.id !== command.sessionId || command.sessionId !== masterSessionId(stream.id))
      return rejected(input.operationId, "forbidden", "Only the Stream master can record master audit events")
    return pending("master_audit_recorded", "stream", stream.id, {
      streamId: stream.id,
      sessionId: command.sessionId,
      wakeTrigger: command.wakeTrigger,
      charterHash: command.charterHash,
      citedCharterClause: command.citedCharterClause,
      modelVersion: command.modelVersion,
      reasoningSummary: command.reasoningSummary,
      toolCalls: command.toolCalls,
      resultingDiffs: command.resultingDiffs,
      evidenceIds: command.evidenceIds,
      outcome: command.outcome,
    }, stream.id)
  }
  if (command.type === "set_stream_lifecycle") {
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
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
    // Closing retires the master lane (pending wakes + the daily schedule);
    // reopening re-arms the schedule under a fresh idempotency key, since
    // wake idempotency dedup is permanent.
    if (command.state === "closed") {
      const lane = workGraphMasterLaneKey({ organizationId: input.organizationId, ownerUserId: input.ownerUserId, streamId: stream.id })
      const wakes = await ctx.db
        .query("wakes")
        .withIndex("by_lane_state", (query: any) => query.eq("serial_key", lane).eq("state", "pending"))
        .take(100)
      await Promise.all(wakes.map((wake: any) => ctx.db.patch(wake._id, { state: "cancelled", resolved_by: "stream_closed" })))
    }
    if (command.state === "reopened") {
      await enqueueMasterSchedule(ctx, input.organizationId, input.ownerUserId, stream.id, now, input.actor.id, `master-schedule:${stream.id}:${now}`)
    }
    return pending("stream_lifecycle_changed", "stream", stream.id, { streamId: stream.id }, stream.id)
  }
  if (command.type === "create_work_source") {
    const sourceId = resourceId("source", input)
    const revisionId = resourceId("revision", input)
    const contentHash = await sha256(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(input.operationId, "validation_error", "Authoring revision content does not match its declared content hash")
    }
    await ctx.db.insert("work_sources", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: sourceId,
      workgraph_id: ROOT_ID,
      title: command.title,
      source_kind: command.authoring ? "authoring" : "manual",
      metadata: command.authoring ?? {},
      latest_revision_id: revisionId,
      latest_revision_number: 1,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("work_source_revisions", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: revisionId,
      work_source_id: sourceId,
      revision_number: 1,
      content: command.content,
      content_hash: contentHash,
      origin: command.authoring ? { kind: "authoring", ...command.authoring } : { kind: "manual" },
      created_by: input.actor,
      schema_version: 1,
      created_at: now,
    })
    return pending("work_source_created", "work_source", sourceId, { workSourceId: sourceId, revisionId })
  }
  if (command.type === "revise_work_source") {
    const source = await owned(ctx, "work_sources", input.organizationId, input.ownerUserId, command.workSourceId)
    if (!source) return rejected(input.operationId, "not_found", "Work Source not found")
    if (source.latest_revision_id !== command.expectedRevisionId)
      return rejected(input.operationId, "version_conflict", "Work Source revision changed")
    if ((source.source_kind === "authoring") !== !!command.authoring) {
      return rejected(input.operationId, "validation_error", "Authoring Work Sources require exact authoring provenance on every revision")
    }
    const authoringIdentity = command.authoring ? AuthoringSourceRevisionSchema.parse(source.metadata) : undefined
    if (command.authoring && (
      command.authoring.adapterId !== authoringIdentity!.adapterId ||
      command.authoring.projectId !== authoringIdentity!.projectId ||
      command.authoring.documentId !== authoringIdentity!.documentId
    )) return rejected(input.operationId, "validation_error", "Authoring revision belongs to a different document")
    const contentHash = await sha256(command.content)
    if (command.authoring && contentHash !== command.authoring.contentHash) {
      return rejected(input.operationId, "validation_error", "Authoring revision content does not match its declared content hash")
    }
    const latest = await owned(ctx, "work_source_revisions", input.organizationId, input.ownerUserId, source.latest_revision_id)
    if (!latest) throw new Error("Work Source head revision is missing")
    const previousOrigin = WorkSourceOriginSchema.parse(latest.origin)
    if (command.authoring && previousOrigin.kind !== "authoring") throw new Error("Authoring Work Source head is missing its authoring origin")
    if (command.authoring && previousOrigin.kind === "authoring" && command.authoring.snapshotId === previousOrigin.snapshotId) {
      return rejected(input.operationId, "version_conflict", "Authoring snapshot is already the Work Source head")
    }
    const revisionId = resourceId("revision", input)
    await ctx.db.insert("work_source_revisions", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: revisionId,
      work_source_id: source.id,
      revision_number: source.latest_revision_number + 1,
      content: command.content,
      content_hash: contentHash,
      origin: command.authoring
        ? { kind: "authoring", ...command.authoring }
        : {
          kind: "manual",
          ...(previousOrigin.kind === "external" || previousOrigin.kind === "manual" && previousOrigin.derivedFromExternal
            ? { derivedFromExternal: true }
            : {}),
        },
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
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const id = resourceId("outcome", input)
    await ctx.db.insert("workgraph_outcomes", {
      organization_id: input.organizationId,
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
    const outcome = await owned(ctx, "workgraph_outcomes", input.organizationId, input.ownerUserId, command.outcomeId)
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
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (command.parentTaskId && (command.dependencyIds?.length ?? 0) > 0)
      return rejected(input.operationId, "validation_error", "Subtasks cannot declare dependencies")
    const parent = command.parentTaskId
      ? await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.parentTaskId)
      : undefined
    if (command.parentTaskId && (!parent || parent.stream_id !== stream.id))
      return rejected(input.operationId, "not_found", "Parent Task not found")
    if (parent?.parent_task_id)
      return rejected(input.operationId, "validation_error", "Subtasks support one nesting level")
    if (parent && input.actor.type !== "user") {
      const parentRuns = await ctx.db
        .query("workgraph_runs")
        .withIndex("by_tenant_item_run", (query: any) =>
          query
            .eq("organization_id", input.organizationId)
            .eq("owner_user_id", input.ownerUserId)
            .eq("work_item_id", parent.id),
        )
        .filter((query: any) =>
          query.or(
            query.eq(query.field("state"), "admitted"),
            query.eq(query.field("state"), "placing"),
            query.eq(query.field("state"), "running"),
          ),
        )
        .take(1)
      if (parentRuns.length === 0)
        return rejected(input.operationId, "blocked", "Subtasks require a live parent Run")
    }
    const sourceRevision = command.source
      ? await exactSourceRevision(ctx, input.organizationId, input.ownerUserId, command.source)
      : undefined
    if (command.source && !sourceRevision)
      return rejected(input.operationId, "not_found", "Work Item source revision not found")
    if (command.outcomeId) {
      const outcome = await owned(ctx, "workgraph_outcomes", input.organizationId, input.ownerUserId, command.outcomeId)
      if (!outcome || outcome.stream_id !== stream.id)
        return rejected(input.operationId, "not_found", "Outcome not found")
    }
    for (const dependencyId of command.dependencyIds ?? []) {
      const dependency = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, dependencyId)
      if (!dependency || dependency.stream_id !== stream.id)
        return rejected(input.operationId, "not_found", "Dependency not found")
    }
    const originRunId = input.actor.type === "agent"
      ? (await ctx.db
          .query("workgraph_session_bindings")
          .withIndex("by_tenant_session", (query: any) => query
            .eq("organization_id", input.organizationId)
            .eq("owner_user_id", input.ownerUserId)
            .eq("session_id", input.actor.id))
          .filter((query: any) => query.and(
            query.eq(query.field("state"), "active"),
            query.eq(query.field("stream_id"), stream.id),
          ))
          .first())?.current_run_id
      : undefined
    const originRun = originRunId
      ? await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, originRunId)
      : undefined
    const originItem = originRun
      ? await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, originRun.work_item_id)
      : undefined
    const sourceRevisionRefs: Array<{
      work_source_id: string
      revision_id: string
      content_hash: string
    }> = command.source
      ? [sourceRef(command.source)]
      : originItem?.source_revision_refs ?? []
    const inheritedSourceRevisions = await Promise.all(
      sourceRevisionRefs.map((reference) =>
        exactSourceRevision(ctx, input.organizationId, input.ownerUserId, {
          workSourceId: reference.work_source_id,
          revisionId: reference.revision_id,
          contentHash: reference.content_hash,
        }),
      ),
    )
    const id = resourceId("work_item", input)
    // Draft intent is inert. Otherwise the compiled Stream autonomy decides
    // whether trusted agent work is admitted; external provenance always keeps
    // the owner approval boundary.
    const bornState = command.draft
      ? "draft"
      : input.actor.type === "user" ||
          (
            streamAutonomy(stream.execution_defaults) === "autonomous" &&
            !sourceRevisionIsUntrusted(sourceRevision) &&
            !inheritedSourceRevisions.some(sourceRevisionIsUntrusted)
          )
        ? "pending"
        : "pending_approval"
    await ctx.db.insert("workgraph_work_items", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id,
      stream_id: stream.id,
      ...(command.parentTaskId === undefined ? {} : { parent_task_id: command.parentTaskId }),
      ...(command.outcomeId === undefined ? {} : { outcome_id: command.outcomeId }),
      title: command.title,
      ...(command.description === undefined ? {} : { description: command.description }),
      state: bornState,
      created_by_actor_type: input.actor.type,
      created_by_actor_id: input.actor.id,
      ...(originRunId === undefined ? {} : { origin_run_id: originRunId }),
      ...(input.actor.type === "agent" && bornState === "pending" ? { auto_admitted: true } : {}),
      priority: command.priority ?? 0,
      source_revision_refs: sourceRevisionRefs,
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
          organization_id: input.organizationId,
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
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (command.outcomeId) {
      const outcome = await owned(ctx, "workgraph_outcomes", input.organizationId, input.ownerUserId, command.outcomeId)
      if (!outcome || outcome.stream_id !== item.stream_id)
        return rejected(input.operationId, "not_found", "Outcome not found")
    }
    const dependencyIds = command.dependencyIds ?? []
    if (item.parent_task_id && dependencyIds.length > 0)
      return rejected(input.operationId, "validation_error", "Subtasks cannot declare dependencies")
    if (dependencyIds.includes(item.id) || new Set(dependencyIds).size !== dependencyIds.length) {
      return rejected(
        input.operationId,
        "validation_error",
        "Dependencies must be unique and cannot reference the Work Item",
      )
    }
    const dependencies = await Promise.all(
      dependencyIds.map((id: string) => owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, id)),
    )
    if (command.dependencyIds && dependencies.some((row: any) => !row || row.stream_id !== item.stream_id)) {
      return rejected(input.operationId, "not_found", "Dependency not found")
    }
    if (command.dependencyIds) {
      const graph = await readConvexDependencyGraph(ctx, input.organizationId, input.ownerUserId, item.stream_id)
      graph.set(item.id, dependencyIds)
      if (dependencyGraphHasCycle([...graph].map(([id, currentDependencyIds]) => ({ id, dependencyIds: currentDependencyIds })))) {
        return rejected(input.operationId, "validation_error", "Work Item dependencies contain a cycle")
      }
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
          .withIndex("by_tenant_item", (q: any) => q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id))
          .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
          .collect(),
        ctx,
      )
      await Promise.all(
        dependencyIds.map((dependencyId: string, index: number) =>
          ctx.db.insert("workgraph_work_item_dependencies", {
            organization_id: input.organizationId,
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
    // Agent material edits re-open the approval gate: an owner-authorized agent
    // mutating an approved-but-not-yet-launched plan demotes it back to
    // `pending_approval` so the owner re-approves (plan §4 rule 2). Human edits
    // re-affirm (their row_version bump already CAS-invalidates any stale approval),
    // and edits to running/terminal items never touch approval.
    const changesMaterialField =
      command.title !== undefined ||
      command.description !== undefined ||
      command.priority !== undefined ||
      command.outcomeId !== undefined ||
      command.dependencyIds !== undefined ||
      command.completionContract !== undefined ||
      command.execution !== undefined
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
    if (
      input.actor.type === "agent" &&
      item.state === "pending" &&
      changesMaterialField &&
      streamAutonomy(stream?.execution_defaults) !== "autonomous"
    ) {
      const current = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, item.id)
      if (current && current.state === "pending") {
        await ctx.db.patch(current._id, {
          state: "pending_approval",
          row_version: current.row_version + 1,
          updated_at: now,
        })
      }
      return pending("work_item_restaged", "work_item", item.id, { workItemId: item.id }, item.stream_id)
    }
    return pending("work_item_updated", "work_item", item.id, { workItemId: item.id }, item.stream_id)
  }
  if (command.type === "cancel_work_item") {
    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, command.workItemId)
    if (!item) return rejected(input.operationId, "not_found", "Work Item not found")
    if (item.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Work Item version changed")
    if (["completed", "abandoned"].includes(item.state))
      return rejected(input.operationId, "invalid_transition", "Work Item is already terminal")
    const runs = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_item_run", (q: any) =>
        q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id),
      )
      .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
      .collect()
    const lease = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_tenant_resource", (q: any) =>
        q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("resource_type", "work_item").eq("resource_id", item.id),
      )
      .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
      .unique()
    if (runs.some((run: any) => !["result", "failed", "cancelled"].includes(run.state)) || lease?.expires_at > now) {
      return rejected(input.operationId, "blocked", "Cancel the active Run before abandoning its Work Item")
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
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
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
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const optionIds = command.options.map((option: any) => option.id)
    if (
      new Set(optionIds).size !== optionIds.length ||
      (command.recommendationOptionId && !optionIds.includes(command.recommendationOptionId))
    ) {
      return rejected(input.operationId, "validation_error", "Decision options are invalid")
    }
    const affected = await Promise.all(
      command.affectedWorkItemIds.map((id: string) => owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, id)),
    )
    if (affected.some((item: any) => !item || item.stream_id !== stream.id))
      return rejected(input.operationId, "not_found", "Affected Work Item not found")
    const id = resourceId("decision", input)
    await ctx.db.insert("workgraph_decisions", {
      organization_id: input.organizationId,
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
          organization_id: input.organizationId,
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
    const decision = await owned(ctx, "workgraph_decisions", input.organizationId, input.ownerUserId, command.decisionId)
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
    const revision = await exactSourceRevision(ctx, input.organizationId, input.ownerUserId, command.source)
    if (!revision) return rejected(input.operationId, "not_found", "Work Source revision not found")
    const source = await owned(ctx, "work_sources", input.organizationId, input.ownerUserId, revision.work_source_id)
    if (!source) return rejected(input.operationId, "not_found", "Work Source not found")
    const targetStream = command.targetStreamId
      ? await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.targetStreamId)
      : undefined
    if (command.targetStreamId && !targetStream)
      return rejected(input.operationId, "not_found", "Target Stream not found")
    const id = resourceId("admission", input)
    const evidence = await sourcePlanningEvidence(ctx, input.organizationId, input.ownerUserId, {
      title: source.title,
      content: revision.content,
      ...(command.targetStreamId ? { targetStreamId: command.targetStreamId } : {}),
      now,
    })
    const previousReference = targetStream
      ? [...(targetStream.source_revision_refs ?? [])].reverse().find((reference: any) =>
          reference.work_source_id === command.source.workSourceId && reference.revision_id !== command.source.revisionId)
      : undefined
    const previousRevision = previousReference
      ? await owned(ctx, "work_source_revisions", input.organizationId, input.ownerUserId, previousReference.revision_id)
      : undefined
    if (previousReference && !previousRevision) throw new Error("Stream source lineage references a missing Work Source revision")
    await ctx.db.insert("workgraph_admission_proposals", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id,
      workgraph_id: ROOT_ID,
      state: "planning",
      source: sourceRef(command.source),
      ...(previousReference ? { previous_source: previousReference } : {}),
      ...(previousRevision ? { diff_summary: sourceRevisionDiffSummary(previousRevision.content, revision.content) } : {}),
      proposal_kind: "source",
      generation: { method: "planning", tryNumber: 0, queuedAt: now },
      ...(command.execution ? { execution_defaults: command.execution } : {}),
      planning_evidence: evidence,
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await ctx.db.insert("workgraph_due_jobs", {
      organization_id: input.organizationId,
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
    const proposal = await owned(ctx, "workgraph_admission_proposals", input.organizationId, input.ownerUserId, command.proposalId)
    if (!proposal) return rejected(input.operationId, "not_found", "Admission proposal not found")
    if (proposal.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Admission proposal version changed")
    if (proposal.state !== "planning_failed")
      return rejected(input.operationId, "invalid_transition", "Admission planning has not failed")
    if (proposal.generation?.method !== "planning_failed" || proposal.generation.retryable !== true)
      return rejected(input.operationId, "invalid_transition", "Admission planning failure is not retryable")
    if (!proposal.source || !(await exactSourceRevision(ctx, input.organizationId, input.ownerUserId, {
      workSourceId: proposal.source.work_source_id,
      revisionId: proposal.source.revision_id,
      contentHash: proposal.source.content_hash,
    }))) return rejected(input.operationId, "version_conflict", "Admission source is no longer current")
    const tryNumber = typeof proposal.generation.tryNumber === "number" ? proposal.generation.tryNumber : 0
    await ctx.db.patch(proposal._id, {
      state: "planning",
      generation: { method: "planning", tryNumber, queuedAt: now },
      suggested_placement: undefined,
      placement_matches: undefined,
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
      duplicate_matches: undefined,
      row_version: proposal.row_version + 1,
      updated_at: now,
    })
    const job = await owned(ctx, "workgraph_due_jobs", input.organizationId, input.ownerUserId, `source_plan_job_${proposal.id}`)
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
      organization_id: input.organizationId,
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
      tryNumber,
    })
  }
  if (command.type === "dismiss_admission" || command.type === "reopen_admission") {
    const proposal = await owned(ctx, "workgraph_admission_proposals", input.organizationId, input.ownerUserId, command.proposalId)
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
    const outcome = await owned(ctx, "workgraph_outcomes", input.organizationId, input.ownerUserId, command.outcomeId)
    if (!outcome) return rejected(input.operationId, "not_found", "Outcome not found")
    if (outcome.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Outcome version changed")
    if (command.type === "close_outcome") {
      const children = await ctx.db
        .query("workgraph_work_items")
        .withIndex("by_tenant_outcome_state", (q: any) =>
          q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("outcome_id", outcome.id),
        )
        .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
        .collect()
      const hasOpen = children.some((item: any) => !["completed", "abandoned"].includes(item.state))
      const confirmations = await ctx.db
        .query("workgraph_evidence")
        .withIndex("by_tenant_subject", (q: any) =>
          q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("subject_type", "outcome").eq("subject_id", outcome.id),
        )
        .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
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
    const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    if (stream.row_version !== command.expectedVersion)
      return rejected(input.operationId, "version_conflict", "Stream version changed")
    if (!validTransition(stream.lifecycle_state, "closed"))
      return rejected(input.operationId, "invalid_transition", "Invalid stream transition")
    const openChildren = (
      await ctx.db
        .query("workgraph_streams")
        .withIndex("by_tenant_parent", (query: any) =>
          query
            .eq("organization_id", input.organizationId)
            .eq("owner_user_id", input.ownerUserId)
            .eq("parent_stream_id", stream.id),
        )
        .collect()
    ).filter((child: any) => child.lifecycle_state !== "closed")
    if (openChildren.length > 0)
      return rejected(
        input.operationId,
        "children_open",
        `Child Streams must close first: ${openChildren.map((child: any) => child.id).join(", ")}`,
        { childStreamIds: openChildren.map((child: any) => child.id) },
      )
    const runs = await streamRows(ctx, input.organizationId, "workgraph_runs", input.ownerUserId, stream.id)
    await Promise.all(
      runs
        .filter((run: any) => ["admitted", "placing", "running"].includes(run.state))
        .map(async (run: any) => {
          await ctx.db.patch(run._id, {
            cancellation: { state: "pending", requestedAt: now, reason: command.reason },
            parked_reason: `Cancellation requested: ${command.reason}`,
            row_version: run.row_version + 1,
            updated_at: now,
          })
        }),
    )
    await enqueueControlEffect(ctx, input, now, {
      effectType: "finalize_stream",
      streamId: stream.id,
      idempotencyKey: `${stream.id}:close-finalize`,
      payload: {
        finalize: "close",
        streamId: stream.id,
        sessions: runs.flatMap((run: any) => (run.session_id ? [run.session_id] : [])),
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
  if (command.type === "record_run_checkpoint" || command.type === "complete_run") {
    const run = await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, command.runId)
    if (!run || run.session_id !== command.sessionId)
      return rejected(input.operationId, "not_found", "Active Run Session not found")
    if (run.state !== "running")
      return rejected(input.operationId, "invalid_transition", "Run is not running")
    const lease = run.execution_kind === "managed"
      ? await ctx.db
          .query("workgraph_leases")
          .withIndex("by_tenant_resource", (query: any) => query
            .eq("organization_id", input.organizationId)
            .eq("owner_user_id", input.ownerUserId)
            .eq("resource_type", "work_item")
            .eq("resource_id", run.work_item_id))
          .filter((query: any) => query.eq(query.field("organization_id"), input.organizationId))
          .unique()
      : undefined
    if (run.execution_kind === "managed" && (
      !lease ||
      lease.holder_id !== run.id ||
      run.generation !== command.generation ||
      lease.epoch !== run.generation ||
      lease.expires_at <= now
    )) return rejected(input.operationId, "version_conflict", "Run lease is no longer active")
    const sessionBindings = await ctx.db
      .query("workgraph_session_bindings")
      .withIndex("by_tenant_session", (query: any) => query
        .eq("organization_id", input.organizationId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("session_id", command.sessionId))
      .collect()
    const existingBinding = sessionBindings.find((binding: any) =>
      binding.state === "active" && binding.current_run_id === run.id)
    if (!existingBinding || existingBinding.project_id !== command.workspaceId)
      return rejected(input.operationId, "invalid_transition", "Run Session is not bound to this workspace")
    const bindingId = existingBinding.id

    if (command.type === "record_run_checkpoint") {
      const evidenceIds = command.evidenceIds ?? []
      const evidence = await Promise.all(evidenceIds.map((id: string) =>
        owned(ctx, "workgraph_evidence", input.organizationId, input.ownerUserId, id)))
      if (evidence.some((record: any) => !record || !(
        (record.subject_type === "work_item" && record.subject_id === run.work_item_id) ||
        record.reference?.sourceRunId === run.id
      ))) return rejected(input.operationId, "not_found", "Checkpoint evidence does not belong to the Run")
      const checkpointId = resourceId("agent_checkpoint", input)
      await ctx.db.insert("workgraph_agent_checkpoints", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: checkpointId,
        stream_id: run.stream_id,
        work_item_id: run.work_item_id,
        run_id: run.id,
        session_binding_id: bindingId,
        level: command.level,
        summary: command.summary,
        evidence_ids: evidenceIds,
        occurred_at: now,
        operation_id: input.operationId,
        provenance: provenance(input),
        row_version: 1,
        schema_version: 1,
        created_at: now,
        updated_at: now,
      })
      return pending(
        "agent_checkpoint_recorded",
        "run",
        run.id,
        { runId: run.id, checkpointId },
        run.stream_id,
      )
    }

    const item = await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, run.work_item_id)
    if (!item) return rejected(input.operationId, "not_found", "Run Task not found")
    const evidenceIds = await Promise.all(command.evidence.map(async (completionEvidence: any, index: number) => {
      const evidenceId = `${resourceId("evidence", input)}_${index}`
      const durable = completionEvidence.evidence.kind === "integration" && completionEvidence.evidence.effect !== "other"
      const receiptId = durable ? `${resourceId("receipt", input)}_${index}` : undefined
      await ctx.db.insert("workgraph_evidence", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: evidenceId,
        stream_id: run.stream_id,
        subject_type: "work_item",
        subject_id: run.work_item_id,
        evidence_kind: completionEvidence.evidence.kind,
        summary: completionEvidence.evidence.summary,
        reference: {
          ...completionEvidence.evidence,
          requirementId: completionEvidence.requirementId,
          sourceRunId: run.id,
          ...(receiptId ? { durableEffectReceiptId: receiptId } : {}),
        },
        provenance: provenance(input),
        schema_version: 1,
        created_at: now,
      })
      if (receiptId) {
        await ctx.db.insert("workgraph_durable_effect_receipts", {
          organization_id: input.organizationId,
          owner_user_id: input.ownerUserId,
          id: receiptId,
          stream_id: run.stream_id,
          run_id: run.id,
          effect_kind: completionEvidence.evidence.effect,
          idempotency_key: `${input.operationId}:integration:${index}`,
          external_reference: { reference: completionEvidence.evidence.reference },
          provenance: provenance(input),
          schema_version: 1,
          created_at: now,
        })
      }
      return evidenceId
    }))
    await ctx.db.patch(run._id, {
      state: "result",
      result: { summary: command.summary, artifacts: command.artifacts ?? [] },
      finished_at: now,
      parked_reason: undefined,
      row_version: run.row_version + 1,
      updated_at: now,
    })
    const resultReady = {
      ...item,
      state: "result_ready",
      evidence_ids: [...item.evidence_ids, ...evidenceIds],
      row_version: item.row_version + 1,
      updated_at: now,
    }
    await ctx.db.patch(item._id, {
      state: resultReady.state,
      evidence_ids: resultReady.evidence_ids,
      row_version: resultReady.row_version,
      updated_at: resultReady.updated_at,
    })
    const completed = await promoteConvexResultReadyItem(ctx, input, {
      ...item,
      state: resultReady.state,
      evidence_ids: resultReady.evidence_ids,
      row_version: resultReady.row_version,
      updated_at: resultReady.updated_at,
    }, now)
    const parent = completed && item.parent_task_id
      ? await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, item.parent_task_id)
      : undefined
    const parentCompleted = parent
      ? await promoteConvexResultReadyItem(ctx, input, parent, now)
      : false
    await syncAttentionResource(ctx, input.organizationId, input.ownerUserId, "workgraph_runs", run.id)
    await syncAttentionResource(ctx, input.organizationId, input.ownerUserId, "workgraph_work_items", item.id)
    await releaseRunLeases(ctx, input.organizationId, input.ownerUserId, run)
    if (run.execution_kind === "managed") {
      const binding = existingBinding ?? (await ctx.db
        .query("workgraph_session_bindings")
        .withIndex("by_tenant_id", (query: any) => query
          .eq("organization_id", input.organizationId)
          .eq("owner_user_id", input.ownerUserId)
          .eq("id", bindingId))
        .unique())
      if (binding) await ctx.db.patch(binding._id, {
        state: "released",
        released_at: now,
        row_version: binding.row_version + 1,
        updated_at: now,
      })
    }
    if (completed || parentCompleted) {
      const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, run.stream_id)
      if (stream) await continueStream(ctx, stream, now)
    }
    await enqueueMasterWake(
      ctx,
      input.organizationId,
      input.ownerUserId,
      run.stream_id,
      now,
      "task_settled",
      input.actor.id,
      command.artifacts ?? [],
    )
    return pending(
      "run_completed",
      "run",
      run.id,
      {
        runId: run.id,
        workItemId: item.id,
        workItemState: completed ? "completed" : "result_ready",
        evidenceIds,
        ...(item.parent_task_id ? { parentTaskId: item.parent_task_id, parentCompleted } : {}),
      },
      run.stream_id,
    )
  }
  if (command.type === "record_evidence") {
    const subjectId = command.subject.type === "stream" ? command.subject.streamId
      : command.subject.type === "work_item" ? command.subject.workItemId
        : command.subject.outcomeId
    const table = command.subject.type === "stream" ? "workgraph_streams"
      : command.subject.type === "work_item" ? "workgraph_work_items"
        : "workgraph_outcomes"
    const subject = await owned(ctx, table, input.organizationId, input.ownerUserId, subjectId)
    if (!subject) return rejected(input.operationId, "not_found", "Evidence subject not found")
    const stream = command.subject.type === "stream"
      ? subject
      : await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, subject.stream_id)
    if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
    const streamId = command.subject.type === "stream" ? subject.id : subject.stream_id
    const id = resourceId("evidence", input)
    const durableEffectReceiptId = command.evidence.kind === "integration" && command.evidence.effect !== "other"
      ? resourceId("receipt", input)
      : undefined
    await ctx.db.insert("workgraph_evidence", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id,
      stream_id: streamId,
      subject_type: command.subject.type,
      subject_id: subjectId,
      evidence_kind: command.evidence.kind,
      summary: command.evidence.summary,
      reference: {
        ...command.evidence,
        requirementId: command.requirementId,
        sourceRunId: command.sourceRunId,
        ...(durableEffectReceiptId ? { durableEffectReceiptId } : {}),
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
    const completed = command.subject.type === "work_item"
      ? await promoteConvexResultReadyItem(ctx, input, {
          ...subject,
          evidence_ids: [...subject.evidence_ids, id],
          row_version: subject.row_version + 1,
          updated_at: now,
        }, now)
      : false
    const parent = completed && command.subject.type === "work_item" && subject.parent_task_id
      ? await owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, subject.parent_task_id)
      : undefined
    const parentCompleted = parent
      ? await promoteConvexResultReadyItem(ctx, input, parent, now)
      : false
    if (command.evidence.kind === "integration" && command.evidence.effect !== "other") {
      await ctx.db.insert("workgraph_durable_effect_receipts", {
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        id: durableEffectReceiptId!,
        stream_id: streamId,
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
    if (completed || parentCompleted) {
      const currentStream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, streamId)
      if (currentStream) await continueStream(ctx, currentStream, now)
      await enqueueMasterWake(
        ctx,
        input.organizationId,
        input.ownerUserId,
        streamId,
        now,
        "task_settled",
        input.actor.id,
      )
    }
    return pending("evidence_recorded", "evidence", id, {
      evidenceId: id,
      ...(durableEffectReceiptId ? { durableEffectReceiptId } : {}),
      ...(completed ? { workItemState: "completed" } : {}),
      ...(parent ? { parentTaskId: parent.id, parentCompleted } : {}),
    }, streamId)
  }
  const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, command.streamId)
  if (!stream) return rejected(input.operationId, "not_found", "Stream not found")
  const receipts = await ctx.db
    .query("workgraph_durable_effect_receipts")
    .withIndex("by_tenant_stream_created", (q: any) =>
      q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("stream_id", stream.id),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .take(1)
  if (receipts.length > 0) return rejected(input.operationId, "close_required", "Durable effects require close")
  if (stream.row_version !== command.expectedVersion)
    return rejected(input.operationId, "version_conflict", "Stream version changed")
  const runs = await streamRows(ctx, input.organizationId, "workgraph_runs", input.ownerUserId, stream.id)
  await ctx.db.patch(stream._id, {
    deletion: { state: "pending", requestedAt: now },
    row_version: stream.row_version + 1,
    updated_at: now,
  })
  await Promise.all(
    runs
      .filter((run: any) => ["admitted", "placing", "running"].includes(run.state))
      .map((run: any) =>
        ctx.db.patch(run._id, {
          cancellation: { state: "pending", requestedAt: now, reason: "Stream deletion" },
          parked_reason: "Cancellation requested: Stream deletion",
          row_version: run.row_version + 1,
          updated_at: now,
        }),
      ),
  )
  await enqueueControlEffect(ctx, input, now, {
    effectType: "finalize_stream",
    streamId: stream.id,
    idempotencyKey: `${stream.id}:delete-release`,
    payload: {
      finalize: "delete",
      streamId: stream.id,
      sessions: runs.flatMap((run: any) => (run.session_id ? [run.session_id] : [])),
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
    .withIndex("by_tenant_idempotency", (q: any) =>
      q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("idempotency_key", effect.idempotencyKey),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
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
    organization_id: input.organizationId,
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

function syncDeletedAttention(ctx: any, organization: string, owner: string, row: any) {
  const table = row.job_type ? "workgraph_due_jobs"
      : row.run_number !== undefined ? "workgraph_runs"
        : row.question !== undefined ? "workgraph_decisions"
          : row.completion_contract !== undefined ? "workgraph_work_items"
            : undefined
  return table ? removeAttentionRecord(ctx, organization, owner, table, row.id) : undefined
}

async function streamRows(ctx: any, organization: string, table: string, owner: string, streamId: string) {
  return ctx.db
    .query(table)
    .withIndex("by_tenant_stream", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("stream_id", streamId))
    .filter((q: any) => q.eq(q.field("organization_id"), organization))
    .collect()
}

async function sourcePlanningEvidence(
  ctx: any,
  organization: string,
  owner: string,
  input: { title: string; content: string; targetStreamId?: string; now: number },
) {
  const candidate = { title: input.title, body: input.content }
  const [recentRows, pinnedRows] = await Promise.all([
    ctx.db.query("workgraph_streams")
      .withIndex("by_tenant_updated", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
      .filter((q: any) => q.eq(q.field("organization_id"), organization))
      .order("desc").take(48),
    ctx.db.query("workgraph_streams")
      .withIndex("by_tenant_pinned_updated", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("pinned", true))
      .filter((q: any) => q.eq(q.field("organization_id"), organization))
      .order("desc").take(24),
  ])
  const matchable = (row: any) => ({
    id: row.id,
    title: row.title,
    summary: row.description ?? "",
    pinned: row.pinned,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
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
      ...recentRows.filter(visible).slice(24, 40).map((row: any) => matchable(row)),
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
      .withIndex("by_tenant_updated", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
      .filter((q: any) => q.eq(q.field("organization_id"), organization))
      .order("desc").take(48),
    ctx.db.query("workgraph_work_items")
      .withIndex("by_tenant_updated", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
      .filter((q: any) => q.eq(q.field("organization_id"), organization))
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

async function exactSourceRevision(ctx: any, organization: string, owner: string, reference: any) {
  const source = await owned(ctx, "work_sources", organization, owner, reference.workSourceId)
  if (!source || source.latest_revision_id !== reference.revisionId) return undefined
  const revision = await owned(ctx, "work_source_revisions", organization, owner, reference.revisionId)
  if (!revision || revision.work_source_id !== source.id || revision.content_hash !== reference.contentHash)
    return undefined
  return revision
}

async function confirmAdmission(ctx: any, input: CommandInput, command: any, now: number) {
  if (command.charter && command.charter.hash.toLowerCase() !== await sha256(command.charter.text))
    return rejected(input.operationId, "validation_error", "Stream charter text does not match its declared hash")
  const proposal = await owned(ctx, "workgraph_admission_proposals", input.organizationId, input.ownerUserId, command.proposalId)
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
  if (!(await exactSourceRevision(ctx, input.organizationId, input.ownerUserId, command.source)))
    return rejected(input.operationId, "version_conflict", "Admission source is not current")
  if (
    !proposal.source ||
    proposal.source.work_source_id !== command.source.workSourceId ||
    proposal.source.revision_id !== command.source.revisionId
  ) {
    return rejected(input.operationId, "version_conflict", "Admission source does not match proposal")
  }
  const intakeCandidate = proposal.intake_candidate_id
    ? await owned(ctx, "workgraph_intake_candidates", input.organizationId, input.ownerUserId, proposal.intake_candidate_id)
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
  const existing = existingId ? await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, existingId) : undefined
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
  if (dependencyGraphHasCycle((command.workItems ?? []).map((item: any) => ({ id: item.proposalKey, dependencyIds: item.dependencyProposalKeys ?? [] }))))
    return rejected(input.operationId, "validation_error", "Admission Work Item dependencies contain a cycle")
  if (command.selection.mode === "replace") {
    const replacement = await validateConvexReplacement(ctx, input.organizationId, input.ownerUserId, {
      streamId: command.selection.streamId,
      previousSource: proposal.previous_source,
      workItems: command.selection.workItems,
    })
    if (!replacement.ok) return rejected(input.operationId, replacement.code, replacement.message)
  }
  const streamId = ["create", "fork"].includes(command.selection.mode) ? resourceId("stream", input) : existingId
  if (["create", "fork"].includes(command.selection.mode)) {
    await ctx.db.insert("workgraph_streams", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: streamId,
      workgraph_id: ROOT_ID,
      title: command.selection.streamTitle,
      ...(command.charter === undefined ? {} : { charter: command.charter }),
      lifecycle_state: "active",
      visibility: "visible",
      pinned: false,
      execution_defaults: proposal.execution_defaults ?? {},
      activity: { lastActivityAt: now },
      durable_effect_count: 0,
      source_revision_refs: [sourceRef(command.source)],
      provenance: provenance(input),
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
  }
  if (existing && command.selection.mode !== "replace") {
    const revision = sourceRef(command.source)
    await ctx.db.patch(existing._id, {
      source_revision_refs: appendSourceRevision(existing.source_revision_refs ?? [], revision),
      ...(command.charter === undefined ? {} : { charter: command.charter }),
      row_version: existing.row_version + 1,
      updated_at: now,
    })
  }
  if (command.selection.mode === "replace") {
    const items = await streamRows(ctx, input.organizationId, "workgraph_work_items", input.ownerUserId, streamId)
    const workItemIds = new Set(command.selection.workItems.map((item: any) => item.workItemId))
    const runs = (await streamRows(ctx, input.organizationId, "workgraph_runs", input.ownerUserId, streamId))
      .filter((run: any) => workItemIds.has(run.work_item_id) && ["admitted", "placing", "running", "parked"].includes(run.state))
    await Promise.all(
      items
        .filter((item: any) => workItemIds.has(item.id))
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
    await Promise.all(runs.map(async (run: any) => {
      await ctx.db.patch(run._id, {
        state: "parked",
        cancellation: { state: "pending", requestedAt: now, reason: "Replaced by confirmed admission" },
        parked_reason: "Cancellation pending: replaced by confirmed admission",
        row_version: run.row_version + 1,
        updated_at: now,
      })
      await releaseRunLeases(ctx, input.organizationId, input.ownerUserId, run)
      const launch = await ctx.db
        .query("workgraph_outbox")
        .withIndex("by_tenant_idempotency", (q: any) =>
          q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("idempotency_key", `${run.id}:launch`),
        )
        .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
        .unique()
      if (launch?.status === "pending") {
        await ctx.db.patch(launch._id, { status: "cancelled", updated_at: now })
      }
    }))
    await enqueueControlEffect(ctx, input, now, {
      effectType: "finalize_stream",
      streamId,
      idempotencyKey: `${streamId}:replacement:${proposal.id}`,
      payload: {
        finalize: "replace",
        streamId,
        proposalId: proposal.id,
        runIds: runs.map((run: any) => run.id),
        sessions: runs.flatMap((run: any) => run.session_id ? [run.session_id] : []),
      },
    })
    await ctx.db.patch(existing._id, {
      source_revision_refs: appendSourceRevision(existing.source_revision_refs ?? [], sourceRef(command.source)),
      replacement_reset: {
        state: "pending",
        proposalId: proposal.id,
        previousSource: {
          workSourceId: proposal.previous_source.work_source_id,
          revisionId: proposal.previous_source.revision_id,
          contentHash: proposal.previous_source.content_hash,
        },
        source: command.source,
        requestedAt: now,
      },
      ...(command.charter === undefined ? {} : { charter: command.charter }),
      row_version: existing.row_version + 1,
      updated_at: now,
    })
  }
  const outcomes = new Map<string, string>()
  for (const [index, outcome] of (command.outcomes ?? []).entries()) {
    const id = `${resourceId("outcome", input)}_${index}`
    outcomes.set(outcome.proposalKey, id)
    await ctx.db.insert("workgraph_outcomes", {
      organization_id: input.organizationId,
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
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id,
      stream_id: streamId,
      ...(item.outcomeProposalKey ? { outcome_id: outcomes.get(item.outcomeProposalKey) } : {}),
      title: item.title,
      ...(item.description === undefined ? {} : { description: item.description }),
      state: "pending",
      created_by_actor_type: input.actor.type,
      created_by_actor_id: input.actor.id,
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
          organization_id: input.organizationId,
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

async function readConvexDependencyGraph(ctx: any, organizationId: string, ownerUserId: string, streamId: string) {
  const items = await ctx.db
    .query("workgraph_work_items")
    .withIndex("by_tenant_stream", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("stream_id", streamId),
    )
    .collect()
  const graph = new Map<string, string[]>(
    items.map((row: any): [string, string[]] => [String(row.id), []]),
  )
  const dependencies = await ctx.db
    .query("workgraph_work_item_dependencies")
    .withIndex("by_tenant_stream", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("stream_id", streamId),
    )
    .collect()
  dependencies.forEach((row: any) => graph.get(row.work_item_id)?.push(row.depends_on_work_item_id))
  return graph
}

async function validateConvexReplacement(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  input: {
    streamId: string
    previousSource?: { work_source_id: string; revision_id: string }
    workItems: Array<{ workItemId: string; expectedVersion: number }>
  },
) {
  if (!input.previousSource) {
    return { ok: false as const, code: "invalid_transition", message: "Replacement requires an exact previous Work Source revision" }
  }
  const stream = await owned(ctx, "workgraph_streams", organizationId, ownerUserId, input.streamId)
  if (!stream) return { ok: false as const, code: "not_found", message: "Selected Stream not found" }
  if (stream.replacement_reset && stream.replacement_reset.state !== "completed") {
    return { ok: false as const, code: "blocked", message: "Stream replacement cleanup is still pending" }
  }
  const receipts = await ctx.db
    .query("workgraph_durable_effect_receipts")
    .withIndex("by_tenant_stream_created", (q: any) =>
      q.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("stream_id", input.streamId),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), organizationId))
    .take(1)
  if (receipts.length > 0) return { ok: false as const, code: "close_required", message: "Durable effects cannot be replaced" }
  const current = (await streamRows(ctx, organizationId, "workgraph_work_items", ownerUserId, input.streamId))
    .filter((item: any) => !["completed", "abandoned"].includes(item.state))
    .sort((left: any, right: any) => left.id.localeCompare(right.id))
  const linked = (item: any) => (item.source_revision_refs ?? []).some((reference: any) =>
    reference.work_source_id === input.previousSource!.work_source_id &&
    reference.revision_id === input.previousSource!.revision_id)
  if (current.some((item: any) => !linked(item))) {
    return { ok: false as const, code: "blocked", message: "Stream contains unrelated nonterminal work; keep or fork instead" }
  }
  const reviewed = [...input.workItems].sort((left, right) => left.workItemId.localeCompare(right.workItemId))
  if (new Set(reviewed.map((item) => item.workItemId)).size !== reviewed.length || reviewed.length !== current.length) {
    return { ok: false as const, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  if (current.some((item: any, index: number) =>
    item.id !== reviewed[index]?.workItemId || item.row_version !== reviewed[index]?.expectedVersion)) {
    return { ok: false as const, code: "version_conflict", message: "Replacement Task set changed after review" }
  }
  return { ok: true as const }
}

async function admitRun(ctx: any, input: CommandInput, item: any, now: number) {
  const stream = await owned(ctx, "workgraph_streams", input.organizationId, input.ownerUserId, item.stream_id)
  if (!stream) return { ok: false as const, code: "not_found", message: "Stream not found" }
  if (stream.lifecycle_state === "paused")
    return { ok: false as const, code: "blocked", message: "Paused Streams do not admit new Runs" }
  if (stream.lifecycle_state === "closed")
    return { ok: false as const, code: "invalid_transition", message: "Closed Streams do not execute" }
  if (stream.replacement_reset && stream.replacement_reset.state !== "completed")
    return { ok: false as const, code: "blocked", message: "Stream replacement cleanup is still pending" }
  if (["completed", "abandoned"].includes(item.state))
    return { ok: false as const, code: "invalid_transition", message: "Finished Work Items do not execute" }
  const decisions = await ctx.db.query("workgraph_decision_work_items")
    .withIndex("by_tenant_item", (q: any) => q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id))
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId)).collect()
  const pendingDecision = await Promise.all(decisions.map((link: any) =>
    owned(ctx, "workgraph_decisions", input.organizationId, input.ownerUserId, link.decision_id)))
  if (pendingDecision.some((decision: any) => decision && ["proposed", "pending"].includes(decision.state)))
    return { ok: false as const, code: "blocked", message: "Work Item requires a pending Decision" }
  const dependencies = await ctx.db
    .query("workgraph_work_item_dependencies")
    .withIndex("by_tenant_item", (q: any) => q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id))
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .collect()
  const blockers = await Promise.all(
    dependencies.map((dependency: any) =>
      owned(ctx, "workgraph_work_items", input.organizationId, input.ownerUserId, dependency.depends_on_work_item_id),
    ),
  )
  // Abandoned satisfies a dependency (change from completed-only): a rejected or
  // otherwise-abandoned blocker must not deadlock its dependents forever (plan §5.1.4).
  if (blockers.some((blocker: any) => !blocker || !["completed", "abandoned"].includes(blocker.state)))
    return { ok: false as const, code: "blocked", message: "Work Item dependencies are incomplete" }
  const existingLease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (q: any) =>
      q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("resource_type", "work_item").eq("resource_id", item.id),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .unique()
  if (existingLease && existingLease.expires_at > now)
    return { ok: false as const, code: "blocked", message: "Work Item already has an active Run" }
  if (existingLease) {
    const previous = await owned(ctx, "workgraph_runs", input.organizationId, input.ownerUserId, existingLease.holder_id)
    if (previous && ["admitted", "placing", "running"].includes(previous.state)) {
      const parked = {
        ...previous,
        state: "parked",
        parked_reason: "Execution lease expired",
        row_version: previous.row_version + 1,
        updated_at: now,
      }
      await ctx.db.patch(previous._id, parked)
      await syncAttentionResource(ctx, input.organizationId, input.ownerUserId, "workgraph_runs", previous.id)
    }
    await ctx.db.delete(existingLease._id)
  }
  // The master turn owns the shared Stream workspace while pending/acting: no
  // Run admits mid-turn (mirror of the master's live-run deferral).
  const masterState = stream.master_status?.state
  if ((masterState === "acting" || masterState === "pending") && stream.master_status?.turnId)
    return { ok: false as const, code: "blocked", message: "Stream master turn is in progress" }
  const outcome = item.outcome_id
    ? await owned(ctx, "workgraph_outcomes", input.organizationId, input.ownerUserId, item.outcome_id)
    : undefined
  const root = await owned(ctx, "workgraphs", input.organizationId, input.ownerUserId, ROOT_ID)
  const execution = resolveCanonicalRunExecution({
    root: root?.defaults,
    stream: stream.execution_defaults,
    outcome: outcome?.execution_defaults,
    workItem: item.execution_defaults,
  })
  if (!execution.ok)
    return {
      ok: false as const,
      code: execution.error.code === "unknown_agent_profile" ? "validation_error" : "blocked",
      message: execution.error.code === "unknown_agent_profile"
        ? `Unknown agent profile: ${execution.error.profileName}`
        : "Execution profile is incomplete",
    }
  const defaults = execution.profile
  if (defaults.environment?.kind !== "hosted_workspace")
    return {
      ok: false as const,
      code: "blocked",
      message: "Cloud WorkGraph requires a hosted_workspace execution environment",
    }
  const capabilityValidation = validateResolvedExecutionProfileAgainstCapabilities({
    organizationId: input.organizationId as never,
    ownerUserId: input.ownerSubject as never,
    now,
    capabilities: await requiredExecutionCapabilities(ctx, input, now),
    profile: defaults,
  })
  if (!capabilityValidation.ok) {
    return {
      ok: false as const,
      code: "blocked",
      message: `Execution profile is unsupported: ${capabilityValidation.diagnostics.map((item) => item.message).join("; ")}`,
    }
  }
  const streamLease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (q: any) =>
      q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("resource_type", "stream").eq("resource_id", stream.id),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .unique()
  if (streamLease && streamLease.expires_at <= now) await ctx.db.delete(streamLease._id)
  if (resolvedPlacement(defaults.environment.placement) === "shared" && streamLease?.expires_at > now)
    return { ok: false as const, code: "blocked", message: "Stream already has an active Run" }
  if (resolvedPlacement(defaults.environment.placement) !== "shared") {
    const activeLeases = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_tenant_stream", (q: any) =>
        q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("stream_id", stream.id),
      )
      .filter((q: any) =>
        q.and(
          q.eq(q.field("organization_id"), input.organizationId),
          q.eq(q.field("resource_type"), "work_item"),
          q.gt(q.field("expires_at"), now),
        ),
      )
      .collect()
    if (activeLeases.length >= execution.maxParallel)
      return {
        ok: false as const,
        code: "blocked",
        message: `Stream execution width is exhausted (${execution.maxParallel})`,
      }
  }
  const prior = await ctx.db
    .query("workgraph_runs")
    .withIndex("by_tenant_item_run", (q: any) =>
      q.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("work_item_id", item.id),
    )
    .filter((q: any) => q.eq(q.field("organization_id"), input.organizationId))
    .collect() as Array<Doc<"workgraph_runs">>
  const runId = `${resourceId("run", input)}_${item.id}`
  const leaseEpoch =
    Math.max(existingLease?.epoch ?? 0, streamLease?.epoch ?? 0, ...prior.map((run) => run.generation)) + 1
  await ctx.db.insert("workgraph_runs", {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: runId,
    stream_id: stream.id,
    work_item_id: item.id,
    run_number: prior.length + 1,
    generation: leaseEpoch,
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
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: `lease_${runId}`,
    resource_type: "work_item",
    resource_id: item.id,
    stream_id: stream.id,
    holder_id: runId,
    epoch: leaseEpoch,
    expires_at: now + 10 * 60_000,
    row_version: 1,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  if (resolvedPlacement(defaults.environment.placement) === "shared")
    await ctx.db.insert("workgraph_leases", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: `lease_stream_${runId}`,
      resource_type: "stream",
      resource_id: stream.id,
      stream_id: stream.id,
      holder_id: runId,
      epoch: leaseEpoch,
      expires_at: now + 10 * 60_000,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
  await ctx.db.insert("workgraph_outbox", {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: `outbox_${runId}`,
    operation_id: input.operationId,
    stream_id: stream.id,
    effect_type: "launch_run",
    idempotency_key: `${runId}:launch`,
    payload: { runId, workItemId: item.id, streamId: stream.id, leaseEpoch },
    status: "pending",
    available_at: now,
    attempt_count: 0,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  })
  await ctx.db.patch(item._id, { state: "active", row_version: item.row_version + 1, updated_at: now })
  return { ok: true as const, runId, leaseEpoch }
}

async function releaseRunLeases(
  ctx: GenericMutationCtx<DataModel>,
  organization: string,
  owner: string,
  run: Pick<Doc<"workgraph_runs">, "id" | "stream_id" | "work_item_id">,
) {
  const leases = await Promise.all(
    [
      { resourceType: "work_item" as const, resourceId: run.work_item_id },
      { resourceType: "stream" as const, resourceId: run.stream_id },
    ].map((resource) =>
      ctx.db
        .query("workgraph_leases")
        .withIndex("by_tenant_resource", (query) =>
          query.eq("organization_id", organization as Id<"orgs">).eq("owner_user_id", owner as Id<"users">).eq("resource_type", resource.resourceType).eq("resource_id", resource.resourceId),
        )
        .filter((query) => query.eq(query.field("organization_id"), organization as Id<"orgs">))
        .unique(),
    ),
  )
  await Promise.all(leases.flatMap((lease) => lease?.holder_id === run.id ? [ctx.db.delete(lease._id)] : []))
}

async function promoteConvexResultReadyItem(
  ctx: any,
  input: Pick<CommandInput, "organizationId" | "ownerUserId">,
  item: any,
  now: number,
) {
  if (item.state !== "result_ready") return false
  const children = await ctx.db
    .query("workgraph_work_items")
    .withIndex("by_tenant_parent", (query: any) =>
      query
        .eq("organization_id", input.organizationId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("parent_task_id", item.id),
    )
    .filter((query: any) => query.eq(query.field("organization_id"), input.organizationId))
    .collect()
  if (children.some((child: any) => !["completed", "abandoned"].includes(child.state))) return false
  const evidence = await ctx.db
    .query("workgraph_evidence")
    .withIndex("by_tenant_subject", (query: any) =>
      query
        .eq("organization_id", input.organizationId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("subject_type", "work_item")
        .eq("subject_id", item.id),
    )
    .filter((query: any) => query.eq(query.field("organization_id"), input.organizationId))
    .collect()
  if (
    !evaluateCompletionContract(
      item.completion_contract,
      { type: "work_item", workItemId: item.id } as never,
      evidence.map((row: any) => ({
        ...row.reference,
        id: row.id,
        subject: { type: "work_item", workItemId: item.id },
        recordedAt: row.created_at,
        recordedBy: row.provenance.actor,
      })) as never,
    ).satisfied
  ) {
    return false
  }
  await ctx.db.patch(item._id, {
    state: "completed",
    completed_at: now,
    row_version: item.row_version + 1,
    updated_at: now,
  })
  await syncAttentionResource(
    ctx,
    input.organizationId,
    input.ownerUserId,
    "workgraph_work_items",
    item.id,
  )
  return true
}

export function resolveCanonicalRunExecutionDefaults(input: Readonly<{
  root?: Record<string, unknown>
  stream?: Record<string, unknown>
  outcome?: Record<string, unknown>
  workItem?: Record<string, unknown>
}>) {
  const resolved = resolveCanonicalRunExecution(input)
  return resolved.ok ? resolved.profile : undefined
}

function resolveCanonicalRunExecution(input: Readonly<{
  root?: Record<string, unknown>
  stream?: Record<string, unknown>
  outcome?: Record<string, unknown>
  workItem?: Record<string, unknown>
}>) {
  const workgraph = ExecutionProfileDefaultsSchema.safeParse(input.root ?? {})
  const stream = input.stream === undefined ? undefined : ExecutionProfileDefaultsSchema.safeParse(input.stream)
  const outcome = input.outcome === undefined ? undefined : ExecutionProfileDefaultsSchema.safeParse(input.outcome)
  const workItem = input.workItem === undefined ? undefined : ExecutionProfileDefaultsSchema.safeParse(input.workItem)
  if (
    !workgraph.success ||
    stream?.success === false ||
    outcome?.success === false ||
    workItem?.success === false
  )
    return {
      ok: false as const,
      error: { code: "incomplete_execution_profile" as const, missingFields: [] },
    }
  const hierarchy = {
    workgraph: workgraph.data,
    ...(stream?.success ? { stream: stream.data } : {}),
    ...(outcome?.success ? { outcome: outcome.data } : {}),
    ...(workItem?.success ? { workItem: workItem.data } : {}),
  }
  const resolved = resolveExecutionProfile(hierarchy)
  if (!resolved.ok) return resolved
  return {
    ...resolved,
    maxParallel:
      hierarchy.workItem?.maxParallel ??
      hierarchy.outcome?.maxParallel ??
      hierarchy.stream?.maxParallel ??
      hierarchy.workgraph.maxParallel ??
      1,
  }
}

/**
 * Bounded durable recovery for continuous execution. Scans active-lifecycle
 * Streams (pause/resume is the launch gate now) and drains each. Restart recovery
 * re-derives readiness from durable rows on every pass; the CF cron is the floor.
 */
export async function reconcileReadyStreams(ctx: any, organization: string, owner: string, now: number, limit: number) {
  if (await workGraphOwnerDeletionBarrier(ctx, organization, owner)) return { admitted: 0 }
  const streams = await ctx.db.query("workgraph_streams")
    .withIndex("by_tenant_workgraph_lifecycle", (query: any) => query
      .eq("organization_id", organization)
      .eq("owner_user_id", owner)
      .eq("workgraph_id", ROOT_ID)
      .eq("lifecycle_state", "active"))
    .take(Math.max(1, Math.min(100, limit)))
  const admitted: string[] = []
  for (const stream of streams) admitted.push(...await continueStream(ctx, stream, now))
  return { admitted: admitted.length }
}

/**
 * Drain one Stream's approved, launchable Work Items. Re-gated from
 * `execution_mode='autonomous' AND execution_state='active'` to
 * `lifecycle_state === 'active'` — stream pause/resume is the launch gate. The
 * former mode-gated `execution_state='stopped'` writes are replaced by a DERIVED
 * hold (re-evaluated every pass, never persisted): any pending/proposed Decision,
 * any parked/failed Run or failed Work Item holds all new launches
 * until the owner resolves or retries (plan §5.1.8). Only `pending` (approved)
 * items are admitted; `pending_approval` is excluded by construction.
 */
async function continueStream(ctx: any, stream: any, now: number) {
  if (stream.deletion?.state === "pending" || stream.closure?.state === "pending") return []
  // Pause/resume is the launch gate; archived Streams never admit (mirrors the
  // SQLite drain's `lifecycle = 'active' AND visibility <> 'archived'`).
  if (stream.lifecycle_state !== "active" || stream.visibility === "archived") return []
  const [decisions, runs, items, snapshot] = await Promise.all([
    ctx.db.query("workgraph_decisions").withIndex("by_tenant_stream", (q: any) =>
      q.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id).eq("stream_id", stream.id))
      .filter((q: any) => q.eq(q.field("organization_id"), stream.organization_id)).collect(),
    ctx.db.query("workgraph_runs").withIndex("by_tenant_stream", (q: any) =>
      q.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id).eq("stream_id", stream.id))
      .filter((q: any) => q.eq(q.field("organization_id"), stream.organization_id)).collect(),
    ctx.db.query("workgraph_work_items").withIndex("by_tenant_stream", (q: any) =>
      q.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id).eq("stream_id", stream.id)).collect(),
    ctx.db.query("workgraph_execution_capabilities").withIndex("by_tenant", (q: any) =>
      q.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id)).unique(),
  ])
  // Derived stream hold — no persisted stop write.
  if (decisions.some((decision: any) => ["proposed", "pending"].includes(decision.state)) ||
    runs.some((run: any) => ["parked", "failed"].includes(run.state)) ||
    items.some((item: any) => item.state === "failed")) {
    return []
  }
  // A capability-read failure holds this Stream for the current pass only; the next
  // reconcile (or an explicit capability refresh) retries it. No persisted stop.
  if (!snapshot) return []
  const parsedCatalog = ExecutionCapabilitiesSchema.safeParse(snapshot.catalog)
  if (!parsedCatalog.success) return []
  const catalog = parsedCatalog.data
  if (
    typeof snapshot.catalog_revision !== "string" ||
    typeof snapshot.expires_at !== "number" ||
    snapshot.catalog_revision !== catalog.catalogRevision ||
    snapshot.expires_at !== catalog.expiresAt ||
    !isExecutionCapabilityCatalogFresh(catalog, now)
  ) {
    return []
  }
  const ready = items.filter((item: any) => item.state === "pending")
  const admissions: string[] = []
  for (const item of ready) {
    const operationId = `ready_${stream.id}_${item.id}_${item.row_version}`
    const result = await admitRun(ctx, {
      organizationId: String(stream.organization_id),
      ownerUserId: String(stream.owner_user_id),
      ownerSubject: catalog.ownerUserId,
      actor: { type: "system", id: "workgraph_launch_runtime" },
      requestId: operationId,
      operationId,
      command: { version: 1, type: "retry_work_item", workItemId: item.id, expectedVersion: item.row_version },
    }, item, now)
    if (!result.ok) continue
    admissions.push(result.runId)
    await appendSystemWorkGraphChange(ctx, {
      organizationId: String(stream.organization_id), ownerUserId: String(stream.owner_user_id), operationId,
      eventId: `event_${operationId}`, changeId: `change_${operationId}`, resourceType: "run",
      resourceId: result.runId, changeType: "run_admitted",
      payload: { runId: result.runId, workItemId: item.id, streamId: stream.id },
      actorId: "workgraph_launch_runtime", now,
    })
  }
  return admissions
}

async function validateCommandCapabilities(ctx: any, input: CommandInput, now: number) {
  const command = input.command
  const profile = command.type === "update_workgraph_defaults"
    ? command.defaults.execution
    : command.type === "set_stream_charter"
      ? command.compiled
      : command.execution
  // Admission (Run launch) happens exclusively in the drain now, which
  // re-validates the resolved profile against capabilities per item. Command-time
  // capability validation therefore only guards commands that carry a profile.
  if (profile === undefined) return
  const capabilities = await requiredExecutionCapabilities(ctx, input, now).catch((error) => ({
    error: error instanceof Error ? error.message : "Execution capability catalog is unavailable",
  }))
  if ("error" in capabilities) {
    return { code: "execution_unavailable" as const, message: capabilities.error, retryable: true }
  }
  const diagnostics = [
    ...(profile === undefined ? [] : (() => {
      const result = validateExecutionProfileDefaultsAgainstCapabilities({
        organizationId: input.organizationId as never,
        ownerUserId: input.ownerSubject as never,
        now,
        capabilities,
        profile,
      })
      return result.ok ? [] : result.diagnostics
    })()),
  ]
  if (diagnostics.length === 0) return
  return {
    code: "validation_error" as const,
    message: `Capability selections are not available: ${diagnostics.map((item) => `${item.path} (${item.reason})`).join(", ")}`,
  }
}

async function requiredExecutionCapabilities(ctx: any, input: CommandInput, now: number) {
  const snapshot = await ctx.db.query("workgraph_execution_capabilities")
    .withIndex("by_tenant", (query: any) => query
      .eq("organization_id", input.organizationId)
      .eq("owner_user_id", input.ownerUserId))
    .unique()
  if (!snapshot) throw new Error("A server-attested execution capability snapshot is required")
  const catalog = ExecutionCapabilitiesSchema.parse(snapshot.catalog)
  if (
    snapshot.catalog_revision !== catalog.catalogRevision ||
    snapshot.observed_at !== catalog.observedAt ||
    snapshot.expires_at !== catalog.expiresAt ||
    !isExecutionCapabilityCatalogFresh(catalog, now)
  ) {
    throw new Error("A fresh server-attested execution capability snapshot is required")
  }
  return catalog
}

async function ensureOwnerRoot(ctx: any, input: CommandInput, now: number) {
  if (!(await owned(ctx, "workgraphs", input.organizationId, input.ownerUserId, ROOT_ID))) {
    await ctx.db.insert("workgraphs", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: ROOT_ID,
      defaults: {},
      provenance: { actor: input.actor, operationId: input.operationId },
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    })
    await initializeAttentionProjection(ctx, input.organizationId, input.ownerUserId, now)
  }
}

async function syncCommandAttention(ctx: any, organization: string, owner: string, command: any) {
  const tables = new Map([
    ["admission_proposal", "workgraph_admission_proposals"],
    ["decision", "workgraph_decisions"],
    ["work_item", "workgraph_work_items"],
    ["run", "workgraph_runs"],
  ])
  const resources = [
    tables.has(command.resourceType) ? [tables.get(command.resourceType), command.resourceId] : undefined,
    typeof command.value?.proposalId === "string" ? ["workgraph_admission_proposals", command.value.proposalId] : undefined,
    typeof command.value?.proposalId === "string" ? ["workgraph_due_jobs", `source_plan_job_${command.value.proposalId}`] : undefined,
    typeof command.value?.decisionId === "string" ? ["workgraph_decisions", command.value.decisionId] : undefined,
    typeof command.value?.workItemId === "string" ? ["workgraph_work_items", command.value.workItemId] : undefined,
    typeof command.value?.runId === "string" ? ["workgraph_runs", command.value.runId] : undefined,
    ...(Array.isArray(command.value?.runIds) ? command.value.runIds.map((id: string) => ["workgraph_runs", id]) : []),
    // Bulk approve returns per-item results; re-project each approved item so its
    // Staged attention entry clears (it is now `pending`, not an attention state).
    ...(Array.isArray(command.value?.results)
      ? command.value.results.map((result: any) => ["workgraph_work_items", result.workItemId])
      : []),
  ].filter((value): value is [string, string] => Boolean(value?.[0] && value[1]))
  await [...new Map(resources.map((resource) => [`${resource[0]}:${resource[1]}`, resource])).values()]
    .reduce((pending: Promise<unknown>, [table, id]) => pending.then(() => syncAttentionResource(ctx, organization, owner, table, id)), Promise.resolve())
}

async function allocateSequence(ctx: any, organization: string, owner: string, streamId: string, now: number) {
  const row = await ctx.db
    .query("workgraph_stream_sequences")
    .withIndex("by_tenant_stream", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner).eq("stream_id", streamId))
    .filter((q: any) => q.eq(q.field("organization_id"), organization))
    .unique()
  if (!row) {
    await ctx.db.insert("workgraph_stream_sequences", {
      organization_id: organization,
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

async function appendChange(
  ctx: GenericMutationCtx<DataModel>,
  change: Omit<
    Doc<"workgraph_changes">,
    "_id" | "_creationTime" | "organization_id" | "owner_user_id"
  > & Readonly<{ organization_id: string; owner_user_id: string }>,
) {
  const id = await ctx.db.insert("workgraph_changes", {
    ...change,
    organization_id: change.organization_id as Id<"orgs">,
    owner_user_id: change.owner_user_id as Id<"users">,
  })
  const stored = await ctx.db.get(id)
  if (!stored) throw new Error("WorkGraph change append did not become readable")
  return stored._creationTime
}

async function markWorkGraphTenantDirty(
  ctx: GenericMutationCtx<DataModel>,
  organizationId: string,
  ownerUserId: string,
  operationId: string,
  now: number,
) {
  // Commands append independent journal rows. They never read or patch a
  // tenant-wide marker, so unrelated Stream mutations share no OCC hot row.
  return ctx.db.insert("workgraph_dirty_events", {
    organization_id: organizationId as Id<"orgs">,
    owner_user_id: ownerUserId as Id<"users">,
    dirty_at: now,
    dirty_token: operationId,
  })
}

export async function appendSystemWorkGraphChange(ctx: any, input: Readonly<{
  organizationId: string
  ownerUserId: string
  operationId: string
  eventId: string
  changeId: string
  resourceType: string
  resourceId: string
  changeType: string
  payload: Record<string, unknown>
  actorId: string
  streamId?: string
  snapshotRelevant?: boolean
  now: number
}>) {
  const sequence = await allocateSequence(
    ctx,
    input.organizationId,
    input.ownerUserId,
    input.streamId ?? OWNER_EVENT_SEQUENCE,
    input.now,
  )
  await ctx.db.insert("workgraph_events", {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: input.eventId,
    ...(input.streamId ? { stream_id: input.streamId } : {}),
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
  const watermark = await appendChange(ctx, {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: input.changeId,
    cursor: sequence,
    ...(input.streamId ? { stream_id: input.streamId } : {}),
    operation_id: input.operationId,
    event_id: input.eventId,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    change_type: input.changeType,
    payload: input.payload,
    snapshot_relevant: input.snapshotRelevant ?? true,
    schema_version: 1,
    created_at: input.now,
  })
  return { sequence, watermark }
}

export async function appendOwnedWorkGraphChange(ctx: any, input: Readonly<{
  organizationId: string
  ownerUserId: string
  operationId: string
  requestId?: string
  eventId: string
  changeId: string
  resourceType: string
  resourceId: string
  changeType: string
  payload: Record<string, unknown>
  actor: Readonly<{ type: "user" | "agent" | "system"; id: string }>
  streamId: string
  snapshotRelevant?: boolean
  now: number
}>) {
  const sequence = await allocateSequence(ctx, input.organizationId, input.ownerUserId, input.streamId, input.now)
  await ctx.db.insert("workgraph_events", {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: input.eventId,
    stream_id: input.streamId,
    sequence,
    operation_id: input.operationId,
    request_id: input.requestId ?? input.operationId,
    event_type: input.changeType,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    payload: input.payload,
    occurred_at: input.now,
    schema_version: 1,
  })
  const watermark = await appendChange(ctx, {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: input.changeId,
    cursor: sequence,
    stream_id: input.streamId,
    operation_id: input.operationId,
    event_id: input.eventId,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    change_type: input.changeType,
    payload: input.payload,
    snapshot_relevant: input.snapshotRelevant ?? true,
    schema_version: 1,
    created_at: input.now,
  })
  return { sequence, watermark }
}

export async function enqueueMasterWake(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  streamId: string,
  now: number,
  trigger: "mailbox" | "task_settled" | "schedule",
  actorId = "workgraph_runtime",
  receiptRefs: readonly string[] = [],
) {
  const stream = await owned(ctx, "workgraph_streams", organizationId, ownerUserId, streamId)
  // A closed Stream's master never re-arms, and an escalated ('attention')
  // master stays halted — its Needs-you entry and failure counter survive
  // settlements and mailbox traffic until the owner resolves it. An in-flight
  // turn ('pending'/'acting') keeps its turnId/admission fence untouched; the
  // queued event rides the lane wake, never a status rewrite.
  if (!stream || stream.lifecycle_state === "closed") return undefined
  const existing = stream.master_status
  if (existing?.state === "attention") return undefined
  if (!existing || existing.state === "hibernating" || existing.state === "retrying") {
    await ctx.db.patch(stream._id, {
      master_status: {
        ...existing,
        state: existing?.state === "retrying" ? "retrying" : "pending",
        message: trigger === "mailbox" ? "Master message queued" : "Task settlement queued for master",
        receiptRefs: [...receiptRefs].slice(0, 100),
        ...(typeof stream.charter?.hash === "string" ? { charterHash: stream.charter.hash } : {}),
        updatedAt: now,
      },
    })
  }
  const serialKey = workGraphMasterLaneKey({ organizationId, ownerUserId, streamId })
  return createLaneWakeIfIdle(ctx, {
    id: `wake_master_${crypto.randomUUID()}`,
    workspaceId: workGraphMasterLaneWorkspace({ organizationId, ownerUserId, streamId }),
    triggerType: "at",
    kind: "workgraph_master",
    serialKey,
    intentJson: JSON.stringify({ organizationId, ownerUserId, streamId, trigger }),
    state: "pending",
    depth: 0,
    createdBy: actorId,
    createdAt: now,
    fireAt: now,
    attempts: 0,
  })
}

async function enqueueMasterSchedule(
  ctx: any,
  organizationId: string,
  ownerUserId: string,
  streamId: string,
  now: number,
  actorId: string,
  idempotencyKey = `master-schedule:${streamId}`,
) {
  const serialKey = workGraphMasterLaneKey({ organizationId, ownerUserId, streamId })
  return createWakeInTx(ctx, {
    id: `wake_master_schedule_${crypto.randomUUID()}`,
    workspaceId: workGraphMasterLaneWorkspace({ organizationId, ownerUserId, streamId }),
    triggerType: "at",
    kind: "workgraph_master",
    serialKey,
    intentJson: JSON.stringify({ organizationId, ownerUserId, streamId, trigger: "schedule" }),
    state: "pending",
    depth: 0,
    createdBy: actorId,
    createdAt: now,
    fireAt: nextDailyMasterRun(now),
    schedule: MASTER_DAILY_SCHEDULE,
    idempotencyKey,
    attempts: 0,
  })
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
    organization_id: input.organizationId,
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

async function owned(ctx: any, table: string, organization: string, owner: string, id: string) {
  const row = await ctx.db
    .query(table)
    .withIndex("by_tenant", (q: any) => q.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((q: any) => q.eq(q.field("id"), id))
    .unique()
  if (table === "workgraph_streams" && (row?.deletion?.state === "pending" || row?.closure?.state === "pending"))
    return undefined
  return row
}

function sourceRef(value: any) {
  return { work_source_id: value.workSourceId, revision_id: value.revisionId, content_hash: value.contentHash }
}

export { continueStream }

function runLaunchOutbox(
  ctx: GenericMutationCtx<DataModel>,
  organization: string,
  owner: string,
  runId: string,
) {
  return ctx.db
    .query("workgraph_outbox")
    .withIndex("by_tenant_idempotency", (query) =>
      query
        .eq("organization_id", organization as Id<"orgs">)
        .eq("owner_user_id", owner as Id<"users">)
        .eq("idempotency_key", `${runId}:launch`),
    )
    .unique()
}

function streamAutonomy(execution: unknown) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return "supervised"
  return (execution as { autonomy?: unknown }).autonomy === "autonomous" ? "autonomous" : "supervised"
}

function streamExecutionChangeError(
  current: unknown,
  requested: { autonomy?: unknown; budget?: unknown } | undefined,
  actorType: "user" | "agent" | "system",
  confirmAutonomy: boolean | undefined,
) {
  if (
    requested?.autonomy === "autonomous" &&
    streamAutonomy(current) !== "autonomous" &&
    (actorType !== "user" || confirmAutonomy !== true)
  ) {
    return {
      code: "autonomy_confirmation_required" as const,
      message: "Autonomous Streams require explicit owner confirmation",
    }
  }
  const currentBudget =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as { budget?: unknown }).budget
      : undefined
  if (requested !== undefined && JSON.stringify(requested.budget) !== JSON.stringify(currentBudget) && actorType !== "user") {
    return { code: "forbidden" as const, message: "Only the owner can configure a Stream budget" }
  }
}

function sourceRevisionIsUntrusted(revision: { origin?: unknown } | undefined) {
  if (!revision?.origin || typeof revision.origin !== "object" || Array.isArray(revision.origin)) return false
  const origin = revision.origin as { kind?: unknown; derivedFromExternal?: unknown }
  return origin.kind === "external" || origin.derivedFromExternal === true
}

function sourceRevisionDiffSummary(previous: string, current: string) {
  return `Content changed; ${previous.split("\n").length} → ${current.split("\n").length} lines`
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

function rejected(operationId: string, code: string, message: string, details?: Record<string, unknown>) {
  return { ok: false, result: failure(operationId, code, message, details) }
}

function success(operationId: string, cursor: ChangeCursor, value: Record<string, any>) {
  return { ok: true, operationId, cursor, value }
}

function failure(operationId: string, code: string, message: string, details?: Record<string, unknown>) {
  return {
    ok: false,
    operationId,
    error: {
      code,
      message,
      retryable: code === "internal_error" || code === "execution_unavailable",
      ...(details ? { details } : {}),
    },
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
