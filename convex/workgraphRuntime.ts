import type { GenericMutationCtx } from "convex/server"
import { v } from "convex/values"
import { buildRunPrompt } from "@claxedo/workgraph/hosted"
import { masterSessionId, workGraphMasterLaneKey } from "@claxedo/workgraph/contracts"
import { serviceMutation, serviceQuery } from "./model"
import type { DataModel, Doc, Id } from "./_generated/dataModel"
import { removeAttentionRecord, syncAttentionRecord } from "./workgraphAttention"
import { applyWorkGraphCommand, appendSystemWorkGraphChange, enqueueMasterWake, reconcileReadyStreams } from "./workgraphCommands"
import { assertWorkGraphOwnerWritable } from "./workgraphModel"

type RuntimeMutationCtx = GenericMutationCtx<DataModel>

function masterStream(ctx: RuntimeMutationCtx, input: { organization_id: Id<"orgs">; owner_user_id: Id<"users">; stream_id: string }) {
  return ctx.db
    .query("workgraph_streams")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", input.organization_id).eq("owner_user_id", input.owner_user_id).eq("id", input.stream_id),
    )
    .unique()
}

function masterArtifactRefs(runs: readonly Doc<"workgraph_runs">[]) {
  return runs.flatMap((run) => {
    const result = run.result && typeof run.result === "object" ? run.result as Record<string, unknown> : undefined
    return Array.isArray(result?.artifactRefs)
      ? result.artifactRefs.filter((value): value is string => typeof value === "string" && !!value.trim())
      : []
  }).slice(0, 100)
}

/** Trusted non-WorkGraph registry used only to dispatch tenant-scoped workers. */
export const listWorkerTenants = serviceMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) =>
    (await ctx.db.query("org_memberships").take(Math.max(1, Math.min(500, args.limit)))).map((membership) => ({
      organizationId: String(membership.org_id),
      ownerUserId: String(membership.user_id),
    })),
})

/** Bounded global backstop scan for tenants whose durable effects missed a fast-lane nudge. */
export const listStaleTenants = serviceQuery({
  args: {
    now: v.number(),
    threshold_ms: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const staleBefore = args.now - Math.max(1, args.threshold_ms ?? 60_000)
    const limit = Math.max(1, Math.min(500, args.limit ?? 500))
    // This backstop is temporary until staging proves the command fast lane.
    // Scan more rows than the tenant result cap so one noisy tenant cannot
    // consume the entire distinct-tenant dispatch window.
    const rowScanLimit = Math.min(5_000, limit * 10)
    const pending = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_status_available", (query: any) =>
        query.eq("status", "pending").lte("available_at", staleBefore),
      )
      .take(rowScanLimit)
    const claimed = pending.length === rowScanLimit
      ? []
      : await ctx.db
          .query("workgraph_outbox")
          .withIndex("by_status_claim_expiry", (query: any) =>
            query.eq("status", "claimed").lte("claim_expires_at", args.now),
          )
          .take(rowScanLimit - pending.length)
    const rows = [...pending, ...claimed]
    return Array.from(
      new Map(
        rows.map((row) => [
          JSON.stringify([row.organization_id, row.owner_user_id]),
          { organizationId: String(row.organization_id), ownerUserId: String(row.owner_user_id) },
        ]),
      ).values(),
    ).slice(0, limit)
  },
})

/** Reserve or resume one durable hosted master turn for a Stream. */
export const claimMasterTurn = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    stream_id: v.string(),
    trigger: v.union(v.literal("mailbox"), v.literal("task_settled"), v.literal("schedule")),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("workgraph_streams")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id).eq("id", args.stream_id),
      )
      .unique()
    if (!stream || stream.lifecycle_state === "closed") return { state: "settled" as const }
    const owner = await ctx.db.get(args.owner_user_id)
    if (!owner?.clerk_subject) throw new Error("Hosted master owner is unavailable")
    const existing = stream.master_status
    // An escalated master is halted: it never claims a new turn until the
    // owner resolves the Needs-you item. Claiming here would silently rebuild
    // the status and erase both the escalation and the failure counter.
    if (existing?.state === "attention") return { state: "settled" as const }
    const reserved = existing?.turnId && (existing.state === "pending" || existing.state === "acting")
    // Master and task Runs share the Stream workspace. A NEW master turn
    // never starts while an Run is live — the wake defers and re-fires.
    if (!reserved) {
      const liveRun = await ctx.db
        .query("workgraph_runs")
        .withIndex("by_tenant_stream", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id).eq("stream_id", args.stream_id),
        )
        .filter((query: any) =>
          query.or(
            query.eq(query.field("state"), "admitted"),
            query.eq(query.field("state"), "placing"),
            query.eq(query.field("state"), "running"),
          ),
        )
        .first()
      if (liveRun) return { state: "deferred" as const, retryAfterMs: 30_000 }
    }
    const mailbox = await ctx.db
      .query("workgraph_master_mailbox")
      .withIndex("by_tenant_stream_status", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id)
          .eq("stream_id", args.stream_id).eq("status", reserved ? "claimed" : "pending"),
      )
      .take(100)
    if (!reserved) {
      await Promise.all(mailbox.map((message) => ctx.db.patch(message._id, { status: "claimed", updated_at: args.now })))
    }
    const runs = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_stream", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id).eq("stream_id", args.stream_id),
      )
      .order("desc")
      .filter((query: any) =>
        query.or(query.eq(query.field("state"), "result"), query.eq(query.field("state"), "failed"), query.eq(query.field("state"), "cancelled")),
      )
      .take(20)
    const turnId = existing?.turnId ?? `master_turn_${crypto.randomUUID()}`
    const status = reserved
      ? existing
      : {
          state: "pending",
          sessionId: masterSessionId(stream.id),
          turnId,
          admissionConfirmed: false,
          // The failure counter persists across retry re-claims — it is the
          // escalate-and-halt loop-breaker, and only a successful turn
          // completion or owner resolution resets it.
          failureCount: existing?.failureCount ?? 0,
          message: "Master turn reserved",
          receiptRefs: masterArtifactRefs(runs),
          ...(stream.charter?.hash ? { charterHash: stream.charter.hash } : {}),
          updatedAt: args.now,
        }
    if (!reserved) await ctx.db.patch(stream._id, { master_status: status, updated_at: args.now })
    const evidence = await ctx.db
      .query("workgraph_evidence")
      .withIndex("by_tenant_stream", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id).eq("stream_id", args.stream_id),
      )
      .order("desc")
      .take(100)
    return {
      state: status.state === "acting" && status.admissionConfirmed ? "monitor" as const : "launch" as const,
      ownerSubject: owner.clerk_subject,
      stream: {
        id: stream.id,
        title: stream.title,
        charter: stream.charter,
        executionDefaults: stream.execution_defaults,
        rowVersion: stream.row_version,
      },
      sessionId: status.sessionId ?? masterSessionId(stream.id),
      turnId,
      historyAfter: status.historyAfter,
      admissionConfirmed: status.admissionConfirmed ?? false,
      failureCount: status.failureCount ?? 0,
      trigger: args.trigger,
      mailbox: mailbox.map((message) => ({ id: message.id, message: message.message, provenance: message.provenance })),
      runs: runs.map((run) => ({
        id: run.id,
        workItemId: run.work_item_id,
        state: run.state,
        result: run.result,
        resolvedExecution: run.resolved_execution,
        updatedAt: run.updated_at,
      })),
      evidenceIds: evidence.map((item) => item.id),
      artifactRefs: masterArtifactRefs(runs),
    }
  },
})

/** Persist the history fence before admitting the exact, replayable prompt. */
export const reserveMasterAdmission = serviceMutation({
  args: {
    organization_id: v.id("orgs"), owner_user_id: v.id("users"), stream_id: v.string(),
    turn_id: v.string(), history_after: v.number(), now: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await masterStream(ctx, args)
    if (!stream || stream.master_status?.turnId !== args.turn_id) return { accepted: false }
    await ctx.db.patch(stream._id, {
      master_status: { ...stream.master_status, state: "pending", historyAfter: args.history_after, admissionConfirmed: false, message: "Master prompt reserved", updatedAt: args.now },
      updated_at: args.now,
    })
    return { accepted: true }
  },
})

export const confirmMasterAdmission = serviceMutation({
  args: {
    organization_id: v.id("orgs"), owner_user_id: v.id("users"), stream_id: v.string(),
    turn_id: v.string(), now: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await masterStream(ctx, args)
    if (!stream || stream.master_status?.turnId !== args.turn_id) return { accepted: false }
    await ctx.db.patch(stream._id, {
      master_status: { ...stream.master_status, state: "acting", admissionConfirmed: true, message: "Master turn in progress", updatedAt: args.now },
      updated_at: args.now,
    })
    return { accepted: true }
  },
})

/** Atomically records the audit event, consumes this turn's mailbox, and hibernates. */
export const completeMasterTurn = serviceMutation({
  args: {
    organization_id: v.id("orgs"), owner_user_id: v.id("users"), stream_id: v.string(),
    turn_id: v.string(), trigger: v.union(v.literal("mailbox"), v.literal("task_settled"), v.literal("schedule")),
    charter_hash: v.string(), cited_charter_clause: v.string(), model_version: v.string(),
    reasoning_summary: v.string(), tool_calls: v.array(v.string()), resulting_diffs: v.array(v.string()),
    evidence_ids: v.array(v.string()), outcome: v.string(), now: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await masterStream(ctx, args)
    if (!stream || stream.master_status?.turnId !== args.turn_id) return { settled: false }
    if (stream.master_status.state === "attention") return { settled: true, state: "attention" as const }
    const sessionId = masterSessionId(stream.id)
    const result = await applyWorkGraphCommand(ctx, {
      organizationId: String(args.organization_id),
      ownerUserId: String(args.owner_user_id),
      ownerSubject: String(args.owner_user_id),
      actor: { type: "agent", id: sessionId },
      requestId: args.turn_id,
      operationId: `audit_${args.turn_id}`,
      command: {
        version: 1,
        type: "record_master_audit",
        streamId: stream.id,
        expectedVersion: stream.row_version,
        sessionId,
        wakeTrigger: args.trigger,
        charterHash: args.charter_hash,
        citedCharterClause: args.cited_charter_clause,
        modelVersion: args.model_version,
        reasoningSummary: args.reasoning_summary,
        toolCalls: args.tool_calls,
        resultingDiffs: args.resulting_diffs,
        evidenceIds: args.evidence_ids,
        outcome: args.outcome,
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    const claimed = await ctx.db
      .query("workgraph_master_mailbox")
      .withIndex("by_tenant_stream_status", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id)
          .eq("stream_id", args.stream_id).eq("status", "claimed"),
      )
      .take(100)
    await Promise.all(claimed.map((message) => ctx.db.patch(message._id, { status: "consumed", updated_at: args.now })))
    const masterStatus = {
        state: "hibernating", sessionId, message: "Master is up to date", receiptRefs: args.resulting_diffs,
        ...(stream.charter?.hash ? { charterHash: stream.charter.hash } : {}), updatedAt: args.now,
      }
    await ctx.db.patch(stream._id, {
      master_status: masterStatus,
      updated_at: args.now,
    })
    await syncAttentionRecord(ctx, "workgraph_streams", { ...stream, master_status: masterStatus, updated_at: args.now })
    const pending = await ctx.db
      .query("workgraph_master_mailbox")
      .withIndex("by_tenant_stream_status", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id)
          .eq("stream_id", args.stream_id).eq("status", "pending"),
      )
      .first()
    if (pending) await enqueueMasterWake(ctx, String(args.organization_id), String(args.owner_user_id), stream.id, args.now, "mailbox")
    return { settled: true }
  },
})

export const failMasterTurn = serviceMutation({
  args: {
    organization_id: v.id("orgs"), owner_user_id: v.id("users"), stream_id: v.string(),
    turn_id: v.string(), reason: v.string(), now: v.number(),
  },
  handler: async (ctx, args) => {
    const stream = await masterStream(ctx, args)
    if (!stream || stream.master_status?.turnId !== args.turn_id) return { settled: false }
    if (stream.master_status.state === "attention") return { settled: true, state: "attention" as const }
    const failureCount = (stream.master_status.failureCount ?? 0) + 1
    const attention = failureCount >= 3
    const masterStatus = {
        ...stream.master_status,
        state: attention ? "attention" : "retrying",
        ...(attention ? { escalation: "failure_halt" } : {}),
        failureCount,
        message: attention ? `Master halted after repeated failure: ${args.reason}` : "Master turn will retry",
        updatedAt: args.now,
      }
    await ctx.db.patch(stream._id, {
      master_status: masterStatus,
      updated_at: args.now,
    })
    await syncAttentionRecord(ctx, "workgraph_streams", { ...stream, master_status: masterStatus, updated_at: args.now })
    if (attention) {
      const claimed = await ctx.db
        .query("workgraph_master_mailbox")
        .withIndex("by_tenant_stream_status", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id)
            .eq("stream_id", args.stream_id).eq("status", "claimed"),
        )
        .take(100)
      await Promise.all(claimed.map((message) => ctx.db.patch(message._id, { status: "consumed", updated_at: args.now })))
    }
    return attention ? { settled: true, state: "attention" as const } : { settled: false, state: "retrying" as const, retryAfterMs: 5_000 }
  },
})

/** Claim durable advisory launch effects. Convex admission remains the authority. */
export const claimLaunches = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    worker_id: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    await reconcileReadyStreams(ctx, args.organization_id, args.owner_user_id, args.now, args.limit)
    const rows = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("effect_type"), "launch_run"),
          query.or(
            query.eq(query.field("status"), "pending"),
            query.and(query.eq(query.field("status"), "claimed"), query.lte(query.field("claim_expires_at"), args.now)),
          ),
          query.lte(query.field("available_at"), args.now),
        ),
      )
      .take(Math.max(1, Math.min(25, args.limit)))
    return await Promise.all(
      rows.map(async (row) => {
        if (!row.organization_id) return null
        const payload = row.payload as { runId: string; leaseEpoch: number }
        const run = await ctx.db
          .query("workgraph_runs")
          .withIndex("by_tenant_id", (query: any) =>
            query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id),
          )
          .filter((query) =>
            query.and(
              query.eq(query.field("organization_id"), row.organization_id),
              query.eq(query.field("id"), payload.runId),
            ),
          )
          .unique()
        const lease = run
          ? await ctx.db
              .query("workgraph_leases")
              .withIndex("by_tenant_resource", (query: any) =>
                query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id),
              )
              .filter((query) =>
                query.and(
                  query.eq(query.field("resource_type"), "work_item"),
                  query.eq(query.field("resource_id"), run.work_item_id),
                  query.eq(query.field("organization_id"), row.organization_id),
                ),
              )
              .unique()
          : null
        if (
          !run ||
          !lease ||
          lease.holder_id !== run.id ||
          run.generation !== payload.leaseEpoch ||
          lease.epoch !== run.generation ||
          run.cancellation?.state === "pending" ||
          !["admitted", "placing"].includes(run.state)
        ) {
          await ctx.db.patch(row._id, {
            status: "cancelled",
            last_error: "Run lease is no longer current",
            updated_at: args.now,
          })
          return null
        }
        const item = await ctx.db
          .query("workgraph_work_items")
          .withIndex("by_tenant_id", (query: any) =>
            query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id),
          )
          .filter((query) =>
            query.and(
              query.eq(query.field("organization_id"), row.organization_id),
              query.eq(query.field("id"), run.work_item_id),
            ),
          )
          .unique()
        const owner = await ctx.db.get(row.owner_user_id)
        if (
          !item ||
          !owner?.clerk_subject ||
          run.organization_id !== row.organization_id ||
          item.organization_id !== row.organization_id
        ) {
          await ctx.db.patch(row._id, {
            status: "failed",
            last_error: "Run owner or Work Item is unavailable",
            updated_at: args.now,
          })
          return null
        }
        const runRowVersion = run.row_version
        const renewal = await renewWorkGraphRunLease(ctx, {
          organizationId: row.organization_id,
          ownerUserId: row.owner_user_id,
          runId: run.id,
          expectedLeaseEpoch: payload.leaseEpoch,
          now: args.now,
          durationMs: 10 * 60_000,
        })
        if (!renewal) {
          await ctx.db.patch(row._id, {
            status: "cancelled",
            last_error: "Run lease is no longer current",
            updated_at: args.now,
          })
          return null
        }
        if (run.state === "admitted") {
          await ctx.db.patch(run._id, {
            state: "placing",
            row_version: runRowVersion + (renewal.recovered ? 2 : 1),
            updated_at: args.now,
          })
        }
        const retryCount = row.attempt_count
        await ctx.db.patch(row._id, {
          payload: { ...payload, leaseEpoch: renewal.leaseEpoch },
          status: "claimed",
          claimed_by: args.worker_id,
          claim_expires_at: args.now + 60_000,
          attempt_count: row.attempt_count + 1,
          updated_at: args.now,
        })
        const sourceRevisions = await Promise.all((item.source_revision_refs ?? []).map((reference: any) =>
          ctx.db
            .query("work_source_revisions")
            .withIndex("by_tenant_id", (query: any) =>
              query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id)
                .eq("id", reference.revision_id),
            )
            .unique()
        ))
        return {
          ownerUserId: String(row.owner_user_id),
          ownerSubject: owner.clerk_subject,
          outboxId: row.id,
          runId: run.id,
          streamId: run.stream_id,
          workItemId: run.work_item_id,
          leaseEpoch: renewal.leaseEpoch,
          queueLagMs: Math.max(0, args.now - row.available_at),
          activeLeaseAgeMs: Math.max(0, args.now - (lease.updated_at ?? args.now)),
          expiredRecovery: renewal.recovered,
          retryCount,
          orgId: String(row.organization_id),
          title: item.title,
          prompt: buildRunPrompt({
            title: item.title,
            description: item.description,
            completionContract: item.completion_contract,
            connectionIds: Array.isArray(run.resolved_execution.connectionIds)
              ? run.resolved_execution.connectionIds.filter((id: unknown): id is string => typeof id === "string")
              : [],
            untrustedSource: sourceRevisions.some((revision) =>
              revision?.origin?.kind === "external" || revision?.origin?.derivedFromExternal === true),
          }),
          profile: run.resolved_execution,
        }
      }),
    ).then((items) => items.filter((item) => item !== null))
  },
})

export const claimControlEffects = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    worker_id: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.or(
            query.eq(query.field("effect_type"), "interrupt_run"),
            query.eq(query.field("effect_type"), "finalize_stream"),
            query.eq(query.field("effect_type"), "cleanup_stream"),
          ),
          query.or(
            query.eq(query.field("status"), "pending"),
            query.and(query.eq(query.field("status"), "claimed"), query.lte(query.field("claim_expires_at"), args.now)),
          ),
          query.lte(query.field("available_at"), args.now),
        ),
      )
      .take(Math.max(1, Math.min(25, args.limit)))
    return await Promise.all(
      rows.map(async (row) => {
        if (!row.organization_id || !row.stream_id) {
          await ctx.db.patch(row._id, {
            status: "failed",
            last_error: "Control effect owner or Stream identity is unavailable",
            updated_at: args.now,
          })
          return null
        }
        await ctx.db.patch(row._id, {
          status: "claimed",
          claimed_by: args.worker_id,
          claim_expires_at: args.now + 60_000,
          attempt_count: row.attempt_count + 1,
          updated_at: args.now,
        })
        return {
          ownerUserId: String(row.owner_user_id),
          orgId: String(row.organization_id),
          outboxId: row.id,
          streamId: row.stream_id,
          effectType: row.effect_type,
          payload: row.payload,
        }
      }),
    ).then((items) => items.filter((item) => item !== null))
  },
})

export const confirmLaunch = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { outbox, run, lease } = await fenced(ctx, args)
    return {
      accepted:
        !!outbox && !!run && run.cancellation?.state !== "pending" && run.state === "placing" && !!lease,
    }
  },
})

export const settleRejectedProvision = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    worker_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const launch = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.outbox_id),
        ),
      )
      .unique()
    if (!launch) return { settled: false }
    if (launch.status === "cancelled") return { settled: true }
    const payload = launch.payload as { runId?: string }
    if (launch.status !== "claimed" || launch.claimed_by !== args.worker_id || payload.runId !== args.run_id) {
      return { settled: false }
    }
    await ctx.db.patch(launch._id, {
      status: "cancelled",
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: "Launch placement was rejected by its durable fence",
      updated_at: args.now,
    })
    return { settled: true }
  },
})

export const compensateRejectedLaunch = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    worker_id: v.string(),
    session_id: v.string(),
    workspace_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.run_id),
        ),
      )
      .unique()
    const launch = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.outbox_id),
        ),
      )
      .unique()
    if (!run || !launch || launch.claimed_by !== args.worker_id) return { settled: false }
    await ctx.db.patch(launch._id, {
      status: "cancelled",
      last_error: "Launch was rejected after Session creation",
      updated_at: args.now,
    })
    const key = `${run.id}:interrupt`
    const control = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant_idempotency", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("idempotency_key"), key),
        ),
      )
      .unique()
    const payload = {
      finalize: "cancel",
      runId: run.id,
      sessionId: args.session_id,
      workspaceId: args.workspace_id,
    }
    if (control)
      await ctx.db.patch(control._id, {
        payload,
        status: "pending",
        available_at: args.now,
        claimed_by: undefined,
        claim_expires_at: undefined,
        updated_at: args.now,
      })
    else
      await ctx.db.insert("workgraph_outbox", {
        organization_id: args.organization_id,
        owner_user_id: args.owner_user_id,
        id: `outbox_${key}`,
        operation_id: launch.operation_id,
        stream_id: run.stream_id,
        effect_type: "interrupt_run",
        idempotency_key: key,
        payload,
        status: "pending",
        available_at: args.now,
        attempt_count: 0,
        schema_version: 1,
        created_at: args.now,
        updated_at: args.now,
      })
    await ctx.db.patch(run._id, {
      cancellation: {
        ...((run.cancellation as object | undefined) ?? {}),
        state: "pending",
        compensationSessionId: args.session_id,
      },
      parked_reason: "Cancellation requested: launch rejected after Session creation",
      row_version: run.row_version + 1,
      updated_at: args.now,
    })
    return { settled: true }
  },
})

export const completeControlEffect = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    worker_id: v.string(),
    ok: v.boolean(),
    reason: v.optional(v.string()),
    observed_session_id: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("workgraph_outbox")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.outbox_id),
        ),
      )
      .unique()
    if (!row) {
      const receipt = await ctx.db
        .query("workgraph_cleanup_receipts")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), args.organization_id),
            query.eq(query.field("id"), args.outbox_id),
          ),
        )
        .unique()
      return { settled: !!receipt }
    }
    if (row.status !== "claimed" || row.claimed_by !== args.worker_id) return { settled: false }
    if (!args.ok) {
      const replacement = (row.payload as { finalize?: string }).finalize === "replace"
      const exhausted = row.attempt_count >= 3 && !replacement
      await ctx.db.patch(row._id, {
        status: exhausted ? "failed" : "pending",
        available_at: args.now + 60_000,
        claimed_by: undefined,
        claim_expires_at: undefined,
        last_error: args.reason,
        updated_at: args.now,
      })
      if (row.attempt_count >= 3)
        await surfaceControlAttention(ctx, row, args.reason ?? "Hosted lifecycle finalization failed", args.now)
      return {
        settled: true,
        ...(exhausted ? {} : { retryAfterMs: 60_000 }),
      }
    }
    const payload = row.payload as { finalize?: string; runId?: string; runIds?: string[]; proposalId?: string }
    const controlPayload = row.payload as { sessionId?: string }
    if (payload.finalize === "cancel" && controlPayload.sessionId !== args.observed_session_id)
      return { settled: false }
    if (payload.finalize === "cancel" && payload.runId) {
      if (
        !(await finalizeRunCancellation(ctx, args.organization_id, args.owner_user_id, payload.runId, args.now))
      )
        return { settled: false }
    }
    if (payload.finalize === "close" && row.stream_id) {
      const runs = await streamRows(
        ctx,
        args.organization_id,
        "workgraph_runs",
        args.owner_user_id,
        row.stream_id,
      )
      const finalized = await Promise.all(
        runs
          .filter((run) => run.cancellation?.state === "pending")
          .map((run) =>
            finalizeRunCancellation(ctx, args.organization_id, args.owner_user_id, run.id, args.now),
          ),
      )
      if (finalized.includes(false)) return { settled: false }
      const stream = await ctx.db
        .query("workgraph_streams")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), args.organization_id),
            query.eq(query.field("id"), row.stream_id),
          ),
        )
        .unique()
      if (stream?.closure?.state === "pending") {
        const items = await streamRows(
          ctx,
          args.organization_id,
          "workgraph_work_items",
          args.owner_user_id,
          row.stream_id,
        )
        const reason = typeof stream.closure.reason === "string" ? stream.closure.reason : "Stream closed"
        await Promise.all(
          items
            .filter((item) => !["completed", "abandoned"].includes(item.state))
            .map((item) =>
              ctx.db.patch(item._id, {
                state: "abandoned",
                abandoned_at: args.now,
                abandon_reason: reason,
                row_version: item.row_version + 1,
                updated_at: args.now,
              }),
            ),
        )
        await ctx.db.patch(stream._id, {
          lifecycle_state: "closed",
          closed_at: args.now,
          closure: { ...(stream.closure as object), state: "completed", completedAt: args.now },
          row_version: stream.row_version + 1,
          updated_at: args.now,
        })
        // A closed Stream's master lane is retired: pending wakes (including
        // the daily schedule row, which the engine would otherwise re-arm
        // forever) are cancelled with the closure.
        const lane = workGraphMasterLaneKey({ organizationId: args.organization_id, ownerUserId: args.owner_user_id, streamId: row.stream_id })
        const wakes = await ctx.db
          .query("wakes")
          .withIndex("by_lane_state", (query: any) => query.eq("serial_key", lane).eq("state", "pending"))
          .take(100)
        await Promise.all(wakes.map((wake) => ctx.db.patch(wake._id, { state: "cancelled", resolved_by: "stream_closed" })))
      }
    }
    if (payload.finalize === "replace" && row.stream_id) {
      const finalized = await Promise.all(
        (payload.runIds ?? []).map((runId) =>
          finalizeRunCancellation(ctx, args.organization_id, args.owner_user_id, runId, args.now),
        ),
      )
      if (finalized.includes(false)) return { settled: false }
      const stream = await ctx.db
        .query("workgraph_streams")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), args.organization_id),
            query.eq(query.field("id"), row.stream_id),
          ),
        )
        .unique()
      if (
        stream?.replacement_reset &&
        stream.replacement_reset.state !== "completed" &&
        (!payload.proposalId || stream.replacement_reset.proposalId === payload.proposalId)
      ) {
        await ctx.db.patch(stream._id, {
          replacement_reset: { ...stream.replacement_reset, state: "completed", completedAt: args.now },
          envelope: undefined,
          row_version: stream.row_version + 1,
          updated_at: args.now,
        })
        await appendSystemWorkGraphChange(ctx, {
          organizationId: String(args.organization_id),
          ownerUserId: String(args.owner_user_id),
          operationId: `replacement_reset_completed_${row.id}`,
          eventId: `event_replacement_reset_completed_${row.id}`,
          changeId: `change_replacement_reset_completed_${row.id}`,
          resourceType: "stream",
          resourceId: row.stream_id,
          changeType: "stream_replacement_reset_completed",
          payload: { streamId: row.stream_id, proposalId: payload.proposalId ?? stream.replacement_reset.proposalId },
          actorId: "workgraph_runtime",
          now: args.now,
        })
      }
    }
    if (payload.finalize === "delete" && row.stream_id) {
      await ctx.db.insert("workgraph_cleanup_receipts", {
        organization_id: args.organization_id,
        owner_user_id: args.owner_user_id,
        id: row.id,
        idempotency_key: row.idempotency_key,
        effect_type: row.effect_type,
        result: { state: "completed", completedAt: args.now },
        schema_version: 1,
        created_at: args.now,
      })
      await deleteStreamGraph(ctx, args.organization_id, args.owner_user_id, row.stream_id)
      return { settled: true }
    }
    await ctx.db.patch(row._id, {
      status: "completed",
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: undefined,
      updated_at: args.now,
    })
    return { settled: true }
  },
})

async function surfaceControlAttention(
  ctx: RuntimeMutationCtx,
  row: Doc<"workgraph_outbox">,
  reason: string,
  now: number,
) {
  if (!row.organization_id) throw new Error("WorkGraph organization is required")
  const payload = row.payload as { finalize?: string; runId?: string }
  if (payload.finalize === "cancel" && payload.runId) {
    const run = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), row.organization_id),
          query.eq(query.field("id"), payload.runId),
        ),
      )
      .unique()
    if (run) {
      const parked = {
        ...run,
        state: "parked",
        parked_reason: reason,
        cancellation: { ...(run.cancellation as object | undefined), state: "attention", reason, at: now },
        row_version: run.row_version + 1,
        updated_at: now,
      }
      await ctx.db.patch(run._id, parked)
      await syncAttentionRecord(ctx, "workgraph_runs", parked)
    }
    return
  }
  if (!row.stream_id) return
  const stream = await ctx.db
    .query("workgraph_streams")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", row.organization_id).eq("owner_user_id", row.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), row.organization_id),
        query.eq(query.field("id"), row.stream_id),
      ),
    )
    .unique()
  if (!stream) return
  if (payload.finalize === "replace") {
    if (!stream.replacement_reset || stream.replacement_reset.state !== "pending") return
    await ctx.db.patch(stream._id, {
      replacement_reset: { ...stream.replacement_reset, state: "attention" },
      row_version: stream.row_version + 1,
      updated_at: now,
    })
    await appendSystemWorkGraphChange(ctx, {
      organizationId: String(row.organization_id),
      ownerUserId: String(row.owner_user_id),
      operationId: `replacement_reset_attention_${row.id}`,
      eventId: `event_replacement_reset_attention_${row.id}`,
      changeId: `change_replacement_reset_attention_${row.id}`,
      resourceType: "stream",
      resourceId: row.stream_id,
      changeType: "stream_replacement_reset_attention",
      payload: { streamId: row.stream_id, proposalId: stream.replacement_reset.proposalId, reason },
      actorId: "workgraph_runtime",
      now,
    })
    return
  }
  const field = payload.finalize === "delete" ? "deletion" : "closure"
  await ctx.db.patch(stream._id, {
    [field]: { ...((stream[field] as object | undefined) ?? {}), state: "attention", reason, at: now },
    updated_at: now,
  })
}

async function finalizeRunCancellation(
  ctx: RuntimeMutationCtx,
  organization: Id<"orgs">,
  owner: Id<"users">,
  runId: string,
  now: number,
) {
  const run = await ctx.db
    .query("workgraph_runs")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query) =>
      query.and(query.eq(query.field("organization_id"), organization), query.eq(query.field("id"), runId)),
    )
    .unique()
  if (!run || run.cancellation?.state !== "pending") return true
  const launch = await ctx.db
    .query("workgraph_outbox")
    .withIndex("by_tenant_idempotency", (query: any) =>
      query.eq("organization_id", organization).eq("owner_user_id", owner),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), organization),
        query.eq(query.field("idempotency_key"), `${run.id}:launch`),
      ),
    )
    .unique()
  if (launch && ["pending", "claimed"].includes(launch.status)) return false
  await ctx.db.patch(run._id, {
    state: "cancelled",
    cancellation: { ...(run.cancellation as object), state: "completed", completedAt: now },
    finished_at: now,
    row_version: run.row_version + 1,
    updated_at: now,
  })
  const lease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (query: any) =>
      query
        .eq("organization_id", organization)
        .eq("owner_user_id", owner)
        .eq("resource_type", "work_item")
        .eq("resource_id", run.work_item_id),
    )
    .filter((query) => query.eq(query.field("organization_id"), organization))
    .unique()
  if (lease?.holder_id === run.id) await releaseRunLeases(ctx, organization, owner, run)
  return true
}

async function releaseRunLeases(
  ctx: RuntimeMutationCtx,
  organization: Id<"orgs">,
  owner: Id<"users">,
  run: { id: string; stream_id: string; work_item_id: string },
) {
  const leases = await Promise.all(
    [
      ["work_item", run.work_item_id],
      ["stream", run.stream_id],
    ].map(([resourceType, resourceId]) =>
      ctx.db
        .query("workgraph_leases")
        .withIndex("by_tenant_resource", (query: any) =>
          query.eq("organization_id", organization).eq("owner_user_id", owner).eq("resource_type", resourceType).eq("resource_id", resourceId),
        )
        .filter((query) => query.eq(query.field("organization_id"), organization))
        .unique(),
    ),
  )
  await Promise.all(
    leases
      .filter((lease) => lease?.holder_id === run.id)
      .map((lease) => ctx.db.delete(lease!._id)),
  )
}

async function deleteStreamGraph(
  ctx: RuntimeMutationCtx,
  organization: Id<"orgs">,
  owner: Id<"users">,
  streamId: string,
) {
  const tables = [
    "workgraph_work_item_dependencies",
    "workgraph_decision_work_items",
    "workgraph_evidence",
    "workgraph_durable_effect_receipts",
    "workgraph_runs",
    "workgraph_decisions",
    "workgraph_outcomes",
    "workgraph_leases",
    "workgraph_outbox",
    "workgraph_due_jobs",
    "workgraph_agent_checkpoints",
    "workgraph_session_bindings",
    "workgraph_work_items",
  ] as const
  for (const table of tables) {
    for (const row of await streamRows(ctx, organization, table, owner, streamId)) {
      await removeAttentionRecord(ctx, String(organization), String(owner), table, row.id)
      await ctx.db.delete(row._id)
    }
  }
  const stream = await ctx.db
    .query("workgraph_streams")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query) =>
      query.and(query.eq(query.field("organization_id"), organization), query.eq(query.field("id"), streamId)),
    )
    .unique()
  if (stream?.deletion?.state === "pending") await ctx.db.delete(stream._id)
}

function streamRows<Table extends Parameters<RuntimeMutationCtx["db"]["query"]>[0]>(
  ctx: RuntimeMutationCtx,
  organization: Id<"orgs">,
  table: Table,
  owner: Id<"users">,
  streamId: string,
) {
  return ctx.db
    .query(table)
    .withIndex("by_tenant_stream" as never, (query: any) =>
      query.eq("organization_id", organization).eq("owner_user_id", owner).eq("stream_id", streamId),
    )
    .filter((query: any) => query.eq(query.field("organization_id"), organization))
    .collect()
}

export const markRunning = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    workspace_id: v.string(),
    session_id: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { outbox, run, lease } = await fenced(ctx, args)
    if (!outbox || !run || run.cancellation?.state === "pending" || !lease || run.state !== "placing")
      return { settled: false }
    const sessionBindings = await ctx.db
      .query("workgraph_session_bindings")
      .withIndex("by_tenant_session", (query: any) => query
        .eq("organization_id", args.organization_id)
        .eq("owner_user_id", args.owner_user_id)
        .eq("session_id", args.session_id))
      .collect()
    const activeBinding = sessionBindings.find((binding) => binding.state === "active")
    if (activeBinding && activeBinding.current_run_id !== run.id) {
      throw new Error("Execution Session is already bound to another Run")
    }
    await ctx.db.patch(run._id, {
      state: "running",
      envelope_id: args.workspace_id,
      session_id: args.session_id,
      started_at: args.now,
      row_version: run.row_version + 1,
      updated_at: args.now,
    })
    if (!activeBinding) await ctx.db.insert("workgraph_session_bindings", {
      organization_id: args.organization_id,
      owner_user_id: args.owner_user_id,
      id: `session_binding_managed_${run.id}`,
      stream_id: run.stream_id,
      session_id: args.session_id,
      project_id: args.workspace_id,
      current_work_item_id: run.work_item_id,
      current_run_id: run.id,
      state: "active",
      bound_at: args.now,
      provenance: { actor: { type: "system", id: "workgraph_hosted_runtime" } },
      row_version: 1,
      schema_version: 1,
      created_at: args.now,
      updated_at: args.now,
    })
    await ctx.db.patch(outbox._id, { status: "completed", updated_at: args.now })
    return { settled: true }
  },
})

export const retryLaunch = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    available_at: v.number(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { outbox, run, lease } = await fenced(ctx, args)
    if (!outbox || !run || run.cancellation?.state === "pending" || !lease || run.state !== "placing")
      return { settled: false }
    await ctx.db.patch(outbox._id, {
      status: "pending",
      available_at: args.available_at,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: args.reason,
      updated_at: args.now,
    })
    return { settled: true, retryAfterMs: Math.max(0, args.available_at - args.now) }
  },
})

export const recordResult = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    run_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    summary: v.string(),
    artifacts: v.array(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    if (!args.summary.trim()) throw new Error("Run result summary must be non-empty")
    if (args.artifacts.some((artifact) => !artifact.trim())) {
      throw new Error("Run result artifacts must contain non-empty references")
    }
    const run = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.run_id),
        ),
      )
      .unique()
    if (!run || run.cancellation?.state === "pending" || run.session_id !== args.session_id) {
      return { settled: false }
    }
    if (run.state === "result") {
      const result = run.result as { summary?: unknown; artifacts?: unknown } | undefined
      if (
        result?.summary === args.summary &&
        Array.isArray(result.artifacts) &&
        JSON.stringify(result.artifacts) === JSON.stringify(args.artifacts)
      )
        return { settled: true }
      throw new Error("Run already has a different terminal result")
    }
    if (run.state !== "running") return { settled: false }
    const lease = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_tenant_resource", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("resource_type"), "work_item"),
          query.eq(query.field("resource_id"), run.work_item_id),
          query.eq(query.field("organization_id"), args.organization_id),
        ),
      )
      .unique()
    if (
      !lease ||
      lease.holder_id !== run.id ||
      run.generation !== args.lease_epoch ||
      lease.epoch !== run.generation ||
      lease.expires_at <= args.now
    )
      return { settled: false }
    const item = await ctx.db
      .query("workgraph_work_items")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), run.work_item_id),
        ),
      )
      .unique()
    await ctx.db.patch(run._id, {
      state: "result",
      result: { summary: args.summary, artifacts: args.artifacts },
      finished_at: args.now,
      row_version: run.row_version + 1,
      updated_at: args.now,
    })
    if (item) {
      const resultReady = { ...item, state: "result_ready", row_version: item.row_version + 1, updated_at: args.now }
      await ctx.db.patch(item._id, {
        state: resultReady.state,
        row_version: resultReady.row_version,
        updated_at: resultReady.updated_at,
      })
      await syncAttentionRecord(ctx, "workgraph_work_items", resultReady)
    }
    await releaseRunLeases(ctx, args.organization_id, args.owner_user_id, run)
    await enqueueMasterWake(
      ctx,
      String(args.organization_id),
      String(args.owner_user_id),
      run.stream_id,
      args.now,
      "task_settled",
      "workgraph_runtime",
      args.artifacts,
    )
    return { settled: true }
  },
})

export const listRunning = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_user_id: v.id("users"), limit: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_state_updated", (query: any) =>
        query
          .eq("organization_id", args.organization_id)
          .eq("owner_user_id", args.owner_user_id)
          .eq("state", "running"),
      )
      .take(Math.max(1, Math.min(25, args.limit)))
    return await Promise.all(
      runs.map(async (run) => {
        if (!run.organization_id) return null
        const lease = await ctx.db
          .query("workgraph_leases")
          .withIndex("by_tenant_resource", (query: any) =>
            query.eq("organization_id", run.organization_id).eq("owner_user_id", run.owner_user_id),
          )
          .filter((query) =>
            query.and(
              query.eq(query.field("resource_type"), "work_item"),
              query.eq(query.field("resource_id"), run.work_item_id),
              query.eq(query.field("organization_id"), run.organization_id),
            ),
          )
          .unique()
        if (
          !lease ||
          lease.holder_id !== run.id ||
          lease.organization_id !== run.organization_id ||
          !run.session_id ||
          !run.envelope_id
        )
          return null
        const renewal = await renewWorkGraphRunLease(ctx, {
          organizationId: run.organization_id,
          ownerUserId: run.owner_user_id,
          runId: run.id,
          expectedLeaseEpoch: lease.epoch,
          now: args.now,
          durationMs: 300_000,
        })
        if (!renewal) return null
        await ctx.db.patch(run._id, { updated_at: args.now })
        return {
          ownerUserId: String(run.owner_user_id),
          orgId: String(run.organization_id),
          runId: run.id,
          streamId: run.stream_id,
          workItemId: run.work_item_id,
          leaseEpoch: renewal.leaseEpoch,
          activeLeaseAgeMs: Math.max(0, args.now - (lease.updated_at ?? args.now)),
          expiredRecovery: renewal.recovered,
          sessionId: run.session_id,
          workspaceId: run.envelope_id,
          ...(run.completion_retry ? {
            completionRetry: {
              terminalSeq: run.completion_retry.terminal_seq,
              requestedAt: run.completion_retry.requested_at,
            },
          } : {}),
        }
      }),
    ).then((items) => items.filter((item) => item !== null))
  },
})

/** Durably fences the single completion-only continuation allowed for a managed Run. */
export const requestCompletionRetry = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    run_id: v.string(),
    session_id: v.string(),
    lease_epoch: v.number(),
    terminal_seq: v.number(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const run = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) => query.eq(query.field("id"), args.run_id))
      .unique()
    if (!run || run.state !== "running" || run.session_id !== args.session_id) {
      return { accepted: false as const }
    }
    const lease = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_tenant_resource", (query: any) =>
        query
          .eq("organization_id", args.organization_id)
          .eq("owner_user_id", args.owner_user_id)
          .eq("resource_type", "work_item")
          .eq("resource_id", run.work_item_id),
      )
      .unique()
    if (
      !lease ||
      lease.holder_id !== run.id ||
      run.generation !== args.lease_epoch ||
      lease.epoch !== run.generation ||
      lease.expires_at <= args.now
    ) return { accepted: false as const }
    if (run.completion_retry) {
      return {
        accepted: true as const,
        terminalSeq: run.completion_retry.terminal_seq,
        requestedAt: run.completion_retry.requested_at,
      }
    }
    await ctx.db.patch(run._id, {
      completion_retry: { terminal_seq: args.terminal_seq, requested_at: args.now },
    })
    return { accepted: true as const, terminalSeq: args.terminal_seq, requestedAt: args.now }
  },
})

export const recordFailure = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    run_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("workgraph_runs")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), args.run_id),
        ),
      )
      .unique()
    if (
      !run ||
      run.cancellation?.state === "pending" ||
      run.state !== "running" ||
      run.session_id !== args.session_id
    )
      return { settled: false }
    const lease = await ctx.db
      .query("workgraph_leases")
      .withIndex("by_tenant_resource", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("resource_type"), "work_item"),
          query.eq(query.field("resource_id"), run.work_item_id),
          query.eq(query.field("organization_id"), args.organization_id),
        ),
      )
      .unique()
    if (
      !lease ||
      lease.holder_id !== run.id ||
      run.generation !== args.lease_epoch ||
      lease.epoch !== run.generation ||
      lease.expires_at <= args.now
    )
      return { settled: false }
    const failed = {
      ...run,
      state: "failed",
      parked_reason: args.reason,
      finished_at: args.now,
      row_version: run.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(run._id, failed)
    await syncAttentionRecord(ctx, "workgraph_runs", failed)
    const item = await ctx.db
      .query("workgraph_work_items")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), run.work_item_id),
        ),
      )
      .unique()
    if (item) {
      const failedItem = { ...item, state: "failed", row_version: item.row_version + 1, updated_at: args.now }
      await ctx.db.patch(item._id, {
        state: failedItem.state,
        row_version: failedItem.row_version,
        updated_at: failedItem.updated_at,
      })
      await syncAttentionRecord(ctx, "workgraph_work_items", failedItem)
    }
    // The Stream halt is now DERIVED, not persisted: the drain re-evaluates a hold
    // from live rows (a failed Work Item or parked Run holds new launches)
    // every pass, so no `execution_state='stopped'` write is needed here.
    await releaseRunLeases(ctx, args.organization_id, args.owner_user_id, run)
    await enqueueMasterWake(
      ctx,
      String(args.organization_id),
      String(args.owner_user_id),
      run.stream_id,
      args.now,
      "task_settled",
    )
    return { settled: true }
  },
})

/** Fenced parked transition when the hosted runtime cannot place a Run. */
export const markParked = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    outbox_id: v.string(),
    run_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const { outbox, run, lease } = await fenced(ctx, args)
    if (!outbox || !run || !lease) return { settled: false }
    const parked = {
      ...run,
      state: "parked",
      parked_reason: args.reason,
      row_version: run.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(run._id, parked)
    await syncAttentionRecord(ctx, "workgraph_runs", parked)
    const item = await ctx.db
      .query("workgraph_work_items")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), run.work_item_id),
        ),
      )
      .unique()
    if (item)
      await ctx.db.patch(item._id, { state: "pending", row_version: item.row_version + 1, updated_at: args.now })
    // The Stream halt is derived from the Run's `parked` state on the next
    // drain pass — no persisted `execution_state='stopped'` write.
    await releaseRunLeases(ctx, args.organization_id, args.owner_user_id, run)
    await ctx.db.patch(outbox._id, {
      status: "failed",
      last_error: args.reason,
      claim_expires_at: undefined,
      updated_at: args.now,
    })
    return { settled: true }
  },
})

async function fenced(
  ctx: RuntimeMutationCtx,
  args: {
    organization_id: Id<"orgs">
    owner_user_id: Id<"users">
    outbox_id: string
    run_id: string
    lease_epoch: number
    worker_id: string
    now: number
  },
) {
  const outbox = await ctx.db
    .query("workgraph_outbox")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), args.organization_id),
        query.eq(query.field("id"), args.outbox_id),
      ),
    )
    .unique()
  const run = await ctx.db
    .query("workgraph_runs")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), args.organization_id),
        query.eq(query.field("id"), args.run_id),
      ),
    )
    .unique()
  if (!outbox || !run || outbox.claimed_by !== args.worker_id || outbox.status !== "claimed") return {}
  const lease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (query: any) =>
      query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("resource_type"), "work_item"),
        query.eq(query.field("resource_id"), run.work_item_id),
        query.eq(query.field("organization_id"), args.organization_id),
      ),
    )
    .unique()
  if (
    !lease ||
    lease.holder_id !== run.id ||
    run.generation !== args.lease_epoch ||
    lease.epoch !== run.generation ||
    lease.expires_at <= args.now
  )
    return {}
  return { outbox, run, lease }
}

export const renewRunLease = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    run_id: v.string(),
    lease_epoch: v.number(),
    now: v.number(),
    duration_ms: v.number(),
  },
  handler: (ctx, args) =>
    renewWorkGraphRunLease(ctx, {
      organizationId: args.organization_id,
      ownerUserId: args.owner_user_id,
      runId: args.run_id,
      expectedLeaseEpoch: args.lease_epoch,
      now: args.now,
      durationMs: args.duration_ms,
    }),
})

export async function renewWorkGraphRunLease(
  ctx: RuntimeMutationCtx,
  input: Readonly<{
    organizationId: Id<"orgs">
    ownerUserId: Id<"users">
    runId: string
    expectedLeaseEpoch: number
    now: number
    durationMs: number
  }>,
) {
  const run = await ctx.db
    .query("workgraph_runs")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), input.organizationId),
        query.eq(query.field("id"), input.runId),
      ),
    )
    .unique()
  if (!run || !["admitted", "placing", "running", "parked"].includes(run.state)) return undefined
  const lease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (query: any) =>
      query.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("resource_type"), "work_item"),
        query.eq(query.field("resource_id"), run.work_item_id),
        query.eq(query.field("organization_id"), input.organizationId),
      ),
    )
    .unique()
  const streamLease = await ctx.db
    .query("workgraph_leases")
    .withIndex("by_tenant_resource", (query: any) =>
      query.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId).eq("resource_type", "stream").eq("resource_id", run.stream_id),
    )
    .filter((query) => query.eq(query.field("organization_id"), input.organizationId))
    .unique()
  if (
    !lease ||
    lease.holder_id !== run.id ||
    run.generation !== input.expectedLeaseEpoch ||
    lease.epoch !== run.generation ||
    (streamLease && (
      streamLease.holder_id !== run.id ||
      streamLease.epoch !== input.expectedLeaseEpoch
    ))
  ) return undefined
  const recovered = lease.expires_at <= input.now || (streamLease?.expires_at ?? Number.POSITIVE_INFINITY) <= input.now
  const leaseEpoch = recovered ? lease.epoch + 1 : lease.epoch
  const expiresAt = input.now + input.durationMs
  await ctx.db.patch(lease._id, {
    epoch: leaseEpoch,
    expires_at: expiresAt,
    row_version: lease.row_version + 1,
    updated_at: input.now,
  })
  if (streamLease) {
    await ctx.db.patch(streamLease._id, {
      epoch: leaseEpoch,
      expires_at: expiresAt,
      row_version: streamLease.row_version + 1,
      updated_at: input.now,
    })
  } else {
    // Expand compatibility for Runs admitted before Stream serialization:
    // the first successful renewal installs the sibling fence durably.
    await ctx.db.insert("workgraph_leases", {
      organization_id: input.organizationId,
      owner_user_id: input.ownerUserId,
      id: `lease_stream_${run.id}`,
      resource_type: "stream",
      resource_id: run.stream_id,
      stream_id: run.stream_id,
      holder_id: run.id,
      epoch: leaseEpoch,
      expires_at: expiresAt,
      row_version: 1,
      schema_version: 1,
      created_at: input.now,
      updated_at: input.now,
    })
  }
  if (recovered) {
    await ctx.db.patch(run._id, {
      generation: leaseEpoch,
      row_version: run.row_version + 1,
      updated_at: input.now,
    })
  }
  return { leaseEpoch, expiresAt, recovered }
}
