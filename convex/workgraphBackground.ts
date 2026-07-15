import type { GenericMutationCtx } from "convex/server"
import { v } from "convex/values"
import { AdmissionAgentPlanSchema, ExecutionProfileDefaultsSchema, RecapProfileDefaultsSchema, resolveRecapProfileDefaults } from "@claxedo/workgraph/contracts"
import { cronMutation, serviceMutation } from "./model"
import type { DataModel, Doc, Id } from "./_generated/dataModel"
import { appendSystemWorkGraphChange } from "./workgraphCommands"
import { assertWorkGraphOwnerWritable, workGraphOwnerDeletionBarrier } from "./workgraphModel"
import { initializeAttentionProjection, syncAttentionRecord, syncCandidateTransition } from "./workgraphAttention"

type Ctx = GenericMutationCtx<DataModel>
const leaseDuration = 5 * 60 * 1000
const retryDelay = 60 * 1000

export const scheduleDueRecaps = cronMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const tenants = await ctx.db.query("org_memberships").take(Math.max(1, Math.min(100, args.limit)))
    const created = await Promise.all(
      tenants.map((tenant) =>
        scheduleTenantRecaps(ctx, tenant.org_id, tenant.user_id, Math.max(1, Math.ceil(args.limit / tenants.length))),
      ),
    )
    return { created: created.reduce((total, count) => total + count, 0) }
  },
})

async function scheduleTenantRecaps(ctx: Ctx, organizationId: Id<"orgs">, ownerUserId: Id<"users">, limit: number) {
  const now = Date.now()
  const root = await ctx.db
    .query("workgraphs")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId),
    )
    .filter((query) => query.eq(query.field("id"), "workgraph_default"))
    .unique()
  const streams = await ctx.db
    .query("workgraph_streams")
    .withIndex("by_tenant_recap_due", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).lte("recap_due_at", now),
    )
    .filter((query) => query.neq(query.field("lifecycle_state"), "closed"))
    .take(Math.max(1, Math.min(100, limit)))
  let created = 0
  for (const stream of streams) {
    if (!stream.organization_id) continue
    if (await workGraphOwnerDeletionBarrier(ctx, stream.organization_id, stream.owner_user_id)) continue
    const configuration = explicitStreamRecapConfiguration(stream.recap_defaults, {
      ...(root?.defaults ?? {}),
      ...(stream.execution_defaults ?? {}),
    })
    const activity = stream.activity as { lastActivityAt?: number; recapDueAt?: number }
    const lastActivityAt = activity.lastActivityAt ?? stream.updated_at
    const eligibleAt = configuration.ok
      ? lastActivityAt + configuration.value.quietHours * 60 * 60 * 1000
      : now
    if (configuration.ok) {
      await clearRecoveredRecapConfigurationJobs(ctx, stream, eligibleAt, now)
      if (eligibleAt > now) {
        await ctx.db.patch(stream._id, {
          activity: { ...activity, recapDueAt: eligibleAt },
          recap_due_at: eligibleAt,
          updated_at: now,
        })
        continue
      }
    }
    const events = await ctx.db
      .query("workgraph_events")
      .withIndex("by_tenant_stream_sequence", (query: any) =>
        query.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), stream.organization_id),
          query.eq(query.field("stream_id"), stream.id),
        ),
      )
      .collect()
    const toSequence = events.at(-1)?.sequence ?? 0
    const recaps = await ctx.db
      .query("workgraph_recaps")
      .withIndex("by_tenant_stream_created", (query: any) =>
        query.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), stream.organization_id),
          query.eq(query.field("stream_id"), stream.id),
        ),
      )
      .collect()
    const previous = recaps.at(-1)
    const previousRange = previous?.activity_range as { toSequence?: number } | undefined
    if (toSequence <= (previousRange?.toSequence ?? 0)) continue
    const subjectId = `${stream.id}:${toSequence}`
    const payload = {
      streamId: stream.id,
      ...(previous ? { previousRecapId: previous.id, previousSummary: previous.summary } : {}),
      fromSequence: (previousRange?.toSequence ?? 0) + 1,
      toSequence,
      quietSince: lastActivityAt,
    }
    const existing = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant_subject", (query: any) =>
        query.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), stream.organization_id),
          query.eq(query.field("job_type"), "recap"),
          query.eq(query.field("subject_id"), subjectId),
        ),
      )
      .unique()
    if (existing) {
      const marker = (existing.payload as { configurationRequirement?: { type?: string } }).configurationRequirement
      if ((configuration.ok && marker?.type !== "generation") || (!configuration.ok && marker?.type === "generation"))
        continue
      const changed = configuration.ok
        ? {
            status: "pending",
            due_at: now,
            payload,
            last_error: undefined,
            row_version: existing.row_version + 1,
            updated_at: now,
          }
        : {
            status: "failed",
            due_at: Number.MAX_SAFE_INTEGER,
            payload: { ...payload, configurationRequirement: recapConfigurationRequirement(stream.id) },
            last_error: configuration.error,
            row_version: existing.row_version + 1,
            updated_at: now,
          }
      await ctx.db.patch(existing._id, changed)
      await syncAttentionRecord(ctx, "workgraph_due_jobs", { ...existing, ...changed })
      created += 1
      continue
    }
    const job = {
      organization_id: stream.organization_id,
      owner_user_id: stream.owner_user_id,
      id: `recap_job_${stream.id}_${toSequence}`,
      stream_id: stream.id,
      job_type: "recap",
      subject_id: subjectId,
      due_at: configuration.ok ? now : Number.MAX_SAFE_INTEGER,
      status: configuration.ok ? "pending" : "failed",
      payload: configuration.ok
        ? payload
        : {
            ...payload,
            configurationRequirement: recapConfigurationRequirement(stream.id),
          },
      ...(configuration.ok ? {} : { last_error: configuration.error }),
      lease_epoch: 0,
      row_version: 1,
      schema_version: 1,
      created_at: now,
      updated_at: now,
    }
    await ctx.db.insert("workgraph_due_jobs", job)
    if (!configuration.ok) await syncAttentionRecord(ctx, "workgraph_due_jobs", job)
    created += 1
  }
  return created
}

async function clearRecoveredRecapConfigurationJobs(
  ctx: Ctx,
  stream: Doc<"workgraph_streams">,
  eligibleAt: number,
  now: number,
) {
  if (!stream.organization_id) return
  const jobs = await ctx.db
    .query("workgraph_due_jobs")
    .withIndex("by_tenant", (query: any) =>
      query.eq("organization_id", stream.organization_id).eq("owner_user_id", stream.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), stream.organization_id),
        query.eq(query.field("stream_id"), stream.id),
        query.eq(query.field("job_type"), "recap"),
      ),
    )
    .collect()
  await Promise.all(
    jobs
      .filter((job) => {
        const marker = (job.payload as { configurationRequirement?: { type?: string } }).configurationRequirement
        return ["pending", "failed", "failed_terminal", "attention"].includes(job.status) && marker?.type === "generation"
      })
      .map(async (job) => {
        const changed = {
          status: "completed",
          due_at: eligibleAt,
          last_error: undefined,
          row_version: job.row_version + 1,
          updated_at: now,
        }
        await ctx.db.patch(job._id, changed)
        await syncAttentionRecord(ctx, "workgraph_due_jobs", { ...job, ...changed })
      }),
  )
}

export async function enqueueIndependentSessionIntake(
  ctx: Ctx,
  input: {
    organizationId: Id<"orgs">
    ownerUserId: Id<"users">
    sessionId: string
    title: string
    summary: string
    observedAt: number
    execution?: unknown
  },
) {
  if (await workGraphOwnerDeletionBarrier(ctx, input.organizationId, input.ownerUserId)) return "blocked" as const
  const attempt = await ctx.db
    .query("workgraph_attempts")
    .withIndex("by_tenant", (query: any) =>
      query.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), input.organizationId),
        query.eq(query.field("session_id"), input.sessionId),
      ),
    )
    .first()
  if (attempt) return "ignored" as const
  const existing = await ctx.db
    .query("workgraph_due_jobs")
    .withIndex("by_tenant_subject", (query: any) =>
      query.eq("organization_id", input.organizationId).eq("owner_user_id", input.ownerUserId),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("job_type"), "session_intake"),
        query.eq(query.field("subject_id"), input.sessionId),
        query.eq(query.field("organization_id"), input.organizationId),
      ),
    )
    .unique()
  if (existing) return "existing" as const
  await ctx.db.insert("workgraph_due_jobs", {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    id: `session_intake_job_${input.sessionId}`,
    job_type: "session_intake",
    subject_id: input.sessionId,
    due_at: input.observedAt,
    status: "pending",
    payload: input,
    lease_epoch: 0,
    row_version: 1,
    schema_version: 1,
    created_at: input.observedAt,
    updated_at: input.observedAt,
  })
  return "created" as const
}

export const drainSessionIntake = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_user_id: v.id("users"), now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("job_type"), "session_intake"),
          query.eq(query.field("status"), "pending"),
          query.lte(query.field("due_at"), args.now),
        ),
      )
      .take(Math.max(1, Math.min(25, args.limit)))
    for (const job of jobs) {
      if (!job.organization_id) continue
      if (await workGraphOwnerDeletionBarrier(ctx, job.organization_id, job.owner_user_id)) continue
      const payload = job.payload as {
        sessionId: string
        title: string
        summary: string
        observedAt: number
        execution?: unknown
      }
      let root = await ctx.db
        .query("workgraphs")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), job.organization_id),
            query.eq(query.field("id"), "workgraph_default"),
          ),
        )
        .unique()
      if (!root) {
        const id = await ctx.db.insert("workgraphs", {
          organization_id: job.organization_id,
          owner_user_id: job.owner_user_id,
          id: "workgraph_default",
          defaults: {},
          recap_defaults: {},
          provenance: { actor: { type: "system", id: "workgraph_session_intake" } },
          row_version: 1,
          schema_version: 1,
          created_at: args.now,
          updated_at: args.now,
        })
        root = await ctx.db.get(id)
        await initializeAttentionProjection(ctx, String(job.organization_id), String(job.owner_user_id), args.now)
      }
      const candidate = await ctx.db
        .query("workgraph_intake_candidates")
        .withIndex("by_tenant", (query: any) =>
          query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), job.organization_id),
            query.eq(query.field("id"), `session_intake_${payload.sessionId}`),
          ),
        )
        .unique()
      if (!candidate) {
        const saved = {
          organization_id: job.organization_id,
          owner_user_id: job.owner_user_id,
          id: `session_intake_${payload.sessionId}`,
          workgraph_id: "workgraph_default",
          candidate_kind: "session",
          title: payload.title,
          body: payload.summary,
          normalized: {
            sessionId: payload.sessionId,
            idempotencyKey: `idle-session:${payload.sessionId}`,
            ...(payload.execution ? { execution: payload.execution } : {}),
          },
          status: "unorganized",
          observed_revision: String(payload.observedAt),
          row_version: 1,
          schema_version: 1,
          created_at: payload.observedAt,
          updated_at: payload.observedAt,
        }
        await ctx.db.insert("workgraph_intake_candidates", saved)
        await syncCandidateTransition(ctx, undefined, saved)
      }
      await ctx.db.patch(job._id, { status: "completed", row_version: job.row_version + 1, updated_at: args.now })
    }
    return {
      completed: jobs.length,
      oldestAgeMs: jobs.reduce((oldest, job) => Math.max(oldest, args.now - job.due_at), 0),
    }
  },
})

export const claimRecaps = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    worker_id: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("job_type"), "recap"),
          query.lte(query.field("due_at"), args.now),
          query.or(
            query.eq(query.field("status"), "pending"),
            query.and(query.eq(query.field("status"), "running"), query.lte(query.field("claim_expires_at"), args.now)),
          ),
        ),
      )
      .take(Math.max(1, Math.min(10, args.limit)))
    return (await Promise.all(jobs.map(async (job) => claimRecap(ctx, job, args)))).filter((job) => job !== null)
  },
})

async function claimRecap(ctx: Ctx, job: Doc<"workgraph_due_jobs">, args: { worker_id: string; now: number }) {
  if (!job.organization_id) return null
  if (await workGraphOwnerDeletionBarrier(ctx, job.organization_id, job.owner_user_id)) return null
  const stream = job.stream_id
    ? await ctx.db
        .query("workgraph_streams")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), job.organization_id),
            query.eq(query.field("id"), job.stream_id),
          ),
        )
        .unique()
    : null
  if (!stream || stream.lifecycle_state === "closed") {
    await ctx.db.patch(job._id, {
      status: "cancelled",
      last_error: "Recap Stream is unavailable",
      updated_at: args.now,
    })
    return null
  }
  const payload = job.payload as {
    fromSequence: number
    toSequence: number
    previousSummary?: string
    quietSince: number
    sessionId?: string
  }
  const events = await ctx.db
    .query("workgraph_events")
    .withIndex("by_tenant_stream_sequence", (query: any) =>
      query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), job.organization_id),
        query.eq(query.field("stream_id"), stream.id),
      ),
    )
    .collect()
  const changed = events
    .filter((event) => event.sequence >= payload.fromSequence && event.sequence <= payload.toSequence)
    .slice(-100)
  if (!changed.length) {
    await ctx.db.patch(job._id, {
      status: "cancelled",
      last_error: "Recap activity range is empty",
      updated_at: args.now,
    })
    return null
  }
  const root = await ctx.db
    .query("workgraphs")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), job.organization_id),
        query.eq(query.field("id"), "workgraph_default"),
      ),
    )
    .unique()
  const recap = explicitStreamRecapConfiguration(stream.recap_defaults, {
    ...(root?.defaults ?? {}),
    ...(stream.execution_defaults ?? {}),
  })
  if (!recap.ok) {
    await rejectRecapConfiguration(ctx, job, payload, stream.id, recap.error, args.now)
    return null
  }
  const executionDefaults = {
    ...(root?.defaults as
      | { agent?: string; model?: { providerId?: string; modelId?: string }; effort?: string }
      | undefined),
    ...(stream.execution_defaults as {
      agent?: string
      model?: { providerId?: string; modelId?: string }
      effort?: string
    }),
  }
  const profile = {
    agent: executionDefaults.agent,
    model: recap.value.model,
    effort: recap.value.effort,
  }
  const profileError = generationProfileError("Recap", profile)
  if (profileError) {
    await rejectRecapConfiguration(ctx, job, payload, stream.id, profileError, args.now)
    return null
  }
  const expiredRecovery = job.status === "running"
  const retryCount = job.lease_epoch
  const leaseEpoch = job.lease_epoch + 1
  const claimedJob = {
    ...job,
    status: "running",
    claimed_by: args.worker_id,
    claim_expires_at: args.now + leaseDuration,
    lease_epoch: leaseEpoch,
    payload: { ...payload, generationProfile: { model: profile.model, effort: profile.effort } },
    row_version: job.row_version + 1,
    updated_at: args.now,
  }
  await ctx.db.patch(job._id, claimedJob)
  await syncAttentionRecord(ctx, "workgraph_due_jobs", claimedJob)
  return {
    ownerUserId: String(job.owner_user_id),
    orgId: String(job.organization_id),
    jobId: job.id,
    leaseEpoch,
    queueLagMs: Math.max(0, args.now - job.due_at),
    activeLeaseAgeMs: Math.max(0, args.now - (job.updated_at ?? args.now)),
    expiredRecovery,
    retryCount,
    streamId: stream.id,
    ...(expiredRecovery && payload.sessionId ? { sessionId: payload.sessionId } : {}),
    title: `Recap: ${stream.title}`,
    profile: { agent: profile.agent, model: profile.model, effort: profile.effort, tools: [] as string[] },
    prompt: [
      'Create a concise Stream recap. Return JSON only: {"summary":"...","actionableReferences":[{"type":"decision|attempt|work_item|outcome|stream","id":"..."}]}. Include only references that need the owner\'s attention.',
      `Stream: ${stream.title}`,
      payload.previousSummary ? `Previous recap: ${payload.previousSummary}` : "Previous recap: none",
      `Changed activity (${payload.fromSequence}-${payload.toSequence}):`,
      JSON.stringify(
        changed.map((event) => ({ sequence: event.sequence, type: event.event_type, payload: event.payload })),
      ),
    ].join("\n"),
  }
}

export const markRecapSession = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    workspace_id: v.string(),
    session_id: v.string(),
    admission_confirmed: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await recapJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    if (!job || job.status !== "running" || job.claimed_by !== args.worker_id || job.lease_epoch !== args.lease_epoch)
      return { settled: false }
    await ctx.db.patch(job._id, {
      payload: {
        ...(job.payload as object),
        workspaceId: args.workspace_id,
        sessionId: args.session_id,
        sessionAdmissionConfirmed: args.admission_confirmed,
      },
      updated_at: args.now,
    })
    return { settled: true }
  },
})

export const retryRecapLaunch = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await recapJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    if (!job || job.status !== "running" || job.claimed_by !== args.worker_id || job.lease_epoch !== args.lease_epoch)
      return { settled: false }
    const exhausted = job.lease_epoch >= 3
    const failedJob = {
      ...job,
      status: exhausted ? "failed" : "pending",
      due_at: args.now + retryDelay,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: args.reason,
      row_version: job.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(job._id, failedJob)
    await syncAttentionRecord(ctx, "workgraph_due_jobs", failedJob)
    if (exhausted && job.stream_id)
      await markRecapAttention(ctx, args.organization_id, args.owner_user_id, job.stream_id, args.reason, args.now)
    return { settled: true }
  },
})

export const listRunningRecaps = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_user_id: v.id("users"), limit: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(query.eq(query.field("job_type"), "recap"), query.eq(query.field("status"), "running")),
      )
      .take(Math.max(1, Math.min(10, args.limit)))
    return (
      await Promise.all(
        jobs.map(async (job) => {
          const payload = job.payload as { workspaceId?: string; sessionId?: string }
          const confirmed = (job.payload as { sessionAdmissionConfirmed?: unknown }).sessionAdmissionConfirmed === true
          return confirmed && payload.workspaceId && payload.sessionId && job.organization_id
            ? {
                ownerUserId: String(job.owner_user_id),
                orgId: String(job.organization_id),
                jobId: job.id,
                leaseEpoch: job.lease_epoch,
                workspaceId: payload.workspaceId,
                sessionId: payload.sessionId,
                activeLeaseAgeMs: Math.max(0, args.now - (job.updated_at ?? args.now)),
                expiredRecovery: (job.claim_expires_at ?? Number.MAX_SAFE_INTEGER) <= args.now,
              }
            : null
        }),
      )
    ).filter((job) => job !== null)
  },
})

export const completeRecap = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    summary: v.string(),
    actionable_references: v.optional(v.array(v.any())),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await recapJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    const payload = job?.payload as
      | {
          sessionId?: string
          streamId?: string
          previousRecapId?: string
          fromSequence?: number
          toSequence?: number
          quietSince?: number
          generationProfile?: { model?: { providerId?: string; modelId?: string }; effort?: string }
        }
      | undefined
    if (
      !job ||
      job.status !== "running" ||
      job.lease_epoch !== args.lease_epoch ||
      payload?.sessionId !== args.session_id ||
      !job.stream_id
    )
      return { settled: false }
    const stream = await ctx.db
      .query("workgraph_streams")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("organization_id"), args.organization_id),
          query.eq(query.field("id"), job.stream_id!),
        ),
      )
      .unique()
    if (!stream) return { settled: false }
    const profile = payload.generationProfile
    if (
      typeof profile?.model?.providerId !== "string" ||
      !profile.model.providerId.trim() ||
      typeof profile.model.modelId !== "string" ||
      !profile.model.modelId.trim() ||
      typeof profile.effort !== "string" ||
      !profile.effort.trim()
    ) {
      const reason = "Recap generation profile is missing from its durable claim"
      const exhausted = job.lease_epoch >= 3
      const failedJob = {
        ...job,
        status: exhausted ? "failed" : "pending",
        due_at: args.now + retryDelay,
        claimed_by: undefined,
        claim_expires_at: undefined,
        last_error: reason,
        payload: {
          ...payload,
          configurationRequirement: {
            type: "generation",
            purpose: "recap",
            scope: { type: "stream", streamId: job.stream_id },
          },
        },
        row_version: job.row_version + 1,
        updated_at: args.now,
      }
      await ctx.db.patch(job._id, failedJob)
      await syncAttentionRecord(ctx, "workgraph_due_jobs", failedJob)
      if (exhausted)
        await markRecapAttention(ctx, args.organization_id, args.owner_user_id, job.stream_id, reason, args.now)
      return { settled: true }
    }
    const recapId = `recap_${job.id}`
    const existing = await ctx.db
      .query("workgraph_recaps")
      .withIndex("by_tenant_id", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(query.eq(query.field("organization_id"), args.organization_id), query.eq(query.field("id"), recapId)),
      )
      .unique()
    const actionableReferences = args.actionable_references ?? []
    if (!existing) {
      await ctx.db.insert("workgraph_recaps", {
        organization_id: args.organization_id,
        owner_user_id: args.owner_user_id,
        id: recapId,
        stream_id: stream.id,
        ...(payload.previousRecapId ? { previous_recap_id: payload.previousRecapId } : {}),
        activity_range: {
          fromSequence: payload.fromSequence,
          toSequence: payload.toSequence,
          quietSince: payload.quietSince,
        },
        summary: args.summary,
        actionable_references: actionableReferences,
        generation: {
          state: "succeeded",
          model: profile.model,
          effort: profile.effort,
          generatedAt: args.now,
          method: "agent_session",
          sessionId: args.session_id,
        },
        source_revision_refs: [],
        provenance: { actor: { type: "system", id: "hosted_recap" }, sessionId: args.session_id },
        schema_version: 1,
        created_at: args.now,
      })
      await appendSystemWorkGraphChange(ctx, {
        organizationId: String(args.organization_id),
        ownerUserId: String(args.owner_user_id),
        operationId: `recap_publish_${recapId}`,
        eventId: `event_recap_publish_${recapId}`,
        changeId: `change_recap_publish_${recapId}`,
        resourceType: "recap",
        resourceId: recapId,
        changeType: "recap_published",
        payload: { recapId, streamId: stream.id },
        actorId: "hosted_recap",
        streamId: stream.id,
        now: args.now,
      })
      if (actionableReferences.length > 0) {
        const notification = {
          organization_id: args.organization_id,
          owner_user_id: args.owner_user_id,
          id: `notification_${recapId}`,
          notification_kind: "actionable_recap",
          state: "unread",
          stream_id: stream.id,
          recap_id: recapId,
          row_version: 1,
          schema_version: 1,
          created_at: args.now,
          updated_at: args.now,
        }
        await ctx.db.insert("workgraph_notifications", notification)
        await syncAttentionRecord(ctx, "workgraph_notifications", notification)
      }
    }
    await ctx.db.patch(stream._id, {
      memory: { latestRecapId: recapId, summary: args.summary, updatedAt: args.now },
      updated_at: args.now,
    })
    const completedJob = {
      ...job,
      status: "completed",
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: undefined,
      row_version: job.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(job._id, completedJob)
    await syncAttentionRecord(ctx, "workgraph_due_jobs", completedJob)
    return { settled: true }
  },
})

export const failRecap = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await recapJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    const payload = job?.payload as { sessionId?: string } | undefined
    if (
      !job ||
      job.status !== "running" ||
      job.lease_epoch !== args.lease_epoch ||
      payload?.sessionId !== args.session_id
    )
      return { settled: false }
    const attempts = job.lease_epoch
    const failedJob = {
      ...job,
      status: attempts >= 3 ? "failed" : "pending",
      due_at: args.now + retryDelay,
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: args.reason,
      row_version: job.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(job._id, failedJob)
    await syncAttentionRecord(ctx, "workgraph_due_jobs", failedJob)
    if (attempts >= 3 && job.stream_id) {
      await markRecapAttention(ctx, args.organization_id, args.owner_user_id, job.stream_id, args.reason, args.now)
    }
    return { settled: true }
  },
})

async function markRecapAttention(
  ctx: Ctx,
  organizationId: Id<"orgs">,
  ownerUserId: Id<"users">,
  streamId: string,
  reason: string,
  now: number,
) {
  const stream = await ctx.db
    .query("workgraph_streams")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId),
    )
    .filter((query) =>
      query.and(query.eq(query.field("organization_id"), organizationId), query.eq(query.field("id"), streamId)),
    )
    .unique()
  if (!stream) return
  const memory = stream.memory as { summary?: unknown } | undefined
  await ctx.db.patch(stream._id, {
    memory: {
      ...(stream.memory as object | undefined),
      summary:
        typeof memory?.summary === "string" && memory.summary.trim()
          ? memory.summary
          : "Recap generation needs attention",
      updatedAt: now,
      attention: { type: "recap_failed", reason, at: now },
    },
    updated_at: now,
  })
}

export const claimSourcePlans = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    worker_id: v.string(),
    now: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    await invalidateLegacySourcePlans(ctx, args.organization_id, args.owner_user_id, args.now)
    const jobs = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(
          query.eq(query.field("job_type"), "source_plan"),
          query.lte(query.field("due_at"), args.now),
          query.or(
            query.eq(query.field("status"), "pending"),
            query.eq(query.field("status"), "failed"),
            query.and(query.eq(query.field("status"), "running"), query.lte(query.field("claim_expires_at"), args.now)),
          ),
        ),
      )
      .take(Math.max(1, Math.min(10, args.limit)))
    return (
      await Promise.all(
        jobs.map(async (job) => {
          if (!job.organization_id) return null
          if (await workGraphOwnerDeletionBarrier(ctx, job.organization_id, job.owner_user_id)) return null
          const source = await sourcePlanSource(ctx, job)
          if (!source) {
            await settleSourcePlanFailure(
              ctx,
              job,
              "Source revision or proposal is no longer current",
              false,
              "cancelled",
              args.now,
            )
            return null
          }
          if (source.proposal.state === "planning_failed") {
            const attempt =
              typeof source.proposal.generation?.attempt === "number" ? source.proposal.generation.attempt : 0
            const version = source.proposal.row_version + 1
            const planning = {
              ...source.proposal,
              state: "planning",
              generation: { method: "planning", attempt, queuedAt: args.now },
              row_version: version,
              updated_at: args.now,
            }
            await ctx.db.patch(source.proposal._id, planning)
            await syncAttentionRecord(ctx, "workgraph_admission_proposals", planning)
            await appendSourcePlanChange(ctx, source, version, { method: "planning", attempt }, args.now)
          }
          const root = await ctx.db
            .query("workgraphs")
            .withIndex("by_tenant_id", (query: any) =>
              query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
            )
            .filter((query) =>
              query.and(
                query.eq(query.field("organization_id"), job.organization_id),
                query.eq(query.field("id"), "workgraph_default"),
              ),
            )
            .unique()
          const defaults = root?.defaults as
            | { model?: { providerId?: string; modelId?: string }; effort?: string; agent?: string }
            | undefined
          const profileError = generationProfileError("Source planning", defaults)
          if (profileError) {
            await settleSourcePlanFailure(ctx, job, profileError, true, "failed", args.now, {
              type: "generation",
              purpose: "source_planning",
              scope: { type: "workgraph" },
            })
            return null
          }
          const expiredRecovery = job.status === "running"
          const retryCount = job.lease_epoch
          const leaseEpoch = job.lease_epoch + 1
          const payload = job.payload as { proposalId: string; source: object; automaticFailureCount?: number }
          const claimedPayload =
            job.status === "running"
              ? payload
              : {
                  proposalId: payload.proposalId,
                  source: payload.source,
                  automaticFailureCount: payload.automaticFailureCount ?? 0,
                }
          const claimedJob = {
            ...job,
            status: "running",
            claimed_by: args.worker_id,
            claim_expires_at: args.now + leaseDuration,
            lease_epoch: leaseEpoch,
            payload: claimedPayload,
            row_version: job.row_version + 1,
            updated_at: args.now,
          }
          await ctx.db.patch(job._id, claimedJob)
          await syncAttentionRecord(ctx, "workgraph_due_jobs", claimedJob)
          return {
            ownerUserId: String(job.owner_user_id),
            orgId: String(job.organization_id),
            jobId: job.id,
            leaseEpoch,
            queueLagMs: Math.max(0, args.now - job.due_at),
            activeLeaseAgeMs: Math.max(0, args.now - (job.updated_at ?? args.now)),
            expiredRecovery,
            retryCount,
            proposalId: source.proposal.id,
            ...("sessionId" in claimedPayload && typeof claimedPayload.sessionId === "string"
              ? { sessionId: claimedPayload.sessionId }
              : {}),
            title: `Plan: ${source.workSource.title}`,
            profile: {
              agent: defaults!.agent!,
              model: defaults!.model!,
              effort: defaults!.effort!,
              tools: [] as string[],
            },
            prompt: [
              "Analyze this exact immutable Work Source revision and propose a personal WorkGraph plan.",
              "Return JSON only with exactly: source, suggestedPlacement, placementMatches, proposedOutcomes, proposedWorkItems, duplicateMatches.",
              "Echo source exactly. Preserve only supplied record IDs. Every Outcome needs successCriteria and execution. Every Work Item needs dependencyKeys, a version-1 completionContract, and execution.",
              `Source reference: ${JSON.stringify(source.reference)}`,
              `Source title: ${source.workSource.title}`,
              `Source content: ${source.revision.content}`,
              `Bounded current placement and duplicate evidence: ${JSON.stringify(source.proposal.planning_evidence ?? {})}`,
              "When bounded evidence includes targetStreamId, suggestedPlacement must be existing with that exact Stream ID.",
            ].join("\n"),
          }
        }),
      )
    ).filter((job) => job !== null)
  },
})

async function invalidateLegacySourcePlans(
  ctx: Ctx,
  organizationId: Id<"orgs">,
  ownerUserId: Id<"users">,
  now: number,
) {
  const proposals = await ctx.db
    .query("workgraph_admission_proposals")
    .withIndex("by_tenant", (query: any) =>
      query.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId),
    )
    .filter((query) => query.eq(query.field("state"), "proposed"))
    .take(25)
  await Promise.all(
    proposals.map(async (proposal) => {
      if (!proposal.organization_id) return
      if (await workGraphOwnerDeletionBarrier(ctx, proposal.organization_id, proposal.owner_user_id)) return
      const complete =
        proposal.generation?.method === "agent_session" &&
        typeof proposal.generation.sessionId === "string" &&
        typeof proposal.generation.generatedAt === "number" &&
        AdmissionAgentPlanSchema.safeParse({
          source: proposal.source
            ? {
                workSourceId: proposal.source.work_source_id,
                revisionId: proposal.source.revision_id,
                contentHash: proposal.source.content_hash,
              }
            : undefined,
          suggestedPlacement: proposal.suggested_placement,
          placementMatches: proposal.placement_matches,
          proposedOutcomes: proposal.proposed_outcomes,
          proposedWorkItems: proposal.proposed_work_items,
          duplicateMatches: proposal.duplicate_matches,
        }).success
      if (complete) return
      const retryable = Boolean(
        proposal.source?.work_source_id && proposal.source.revision_id && proposal.source.content_hash,
      )
      const version = proposal.row_version + 1
      const invalidated = {
        ...proposal,
        state: "planning_failed",
        generation: {
          method: "planning_failed",
          attempt: 0,
          reason: "Retired deterministic or incomplete admission plan is non-authoritative",
          invalidatedAt: now,
          retryable,
        },
        planning_evidence: {
          ...(proposal.suggested_placement?.mode === "existing"
            ? { targetStreamId: proposal.suggested_placement.streamId ?? proposal.suggested_placement.stream_id }
            : {}),
          placementMatches: proposal.placement_matches ?? [],
          duplicateMatches: proposal.duplicate_matches ?? [],
        },
        suggested_placement: undefined,
        placement_matches: undefined,
        proposed_outcomes: undefined,
        proposed_work_items: undefined,
        duplicate_matches: undefined,
        row_version: version,
        updated_at: now,
      }
      await ctx.db.patch(proposal._id, invalidated)
      await syncAttentionRecord(ctx, "workgraph_admission_proposals", invalidated)
      if (typeof proposal.source?.work_source_id === "string" && proposal.source.work_source_id.trim()) {
        await appendSourcePlanChange(
          ctx,
          {
            proposal,
            workSource: { id: proposal.source.work_source_id },
          },
          version,
          { method: "planning_failed", attempt: 0, retryable },
          now,
        )
      }
      if (!retryable) return
      const id = `source_plan_job_${proposal.id}`
      const job = await ctx.db
        .query("workgraph_due_jobs")
        .withIndex("by_tenant_subject", (query: any) =>
          query
            .eq("organization_id", proposal.organization_id)
            .eq("owner_user_id", proposal.owner_user_id)
            .eq("job_type", "source_plan")
            .eq("subject_id", proposal.id),
        )
        .filter((query) => query.eq(query.field("organization_id"), proposal.organization_id))
        .unique()
      const payload = { proposalId: proposal.id, source: proposal.source, automaticFailureCount: 0 }
      if (job) {
        const pendingJob = {
          ...job,
          status: "pending",
          due_at: now,
          payload,
          claimed_by: undefined,
          claim_expires_at: undefined,
          last_error: undefined,
          row_version: job.row_version + 1,
          updated_at: now,
        }
        await ctx.db.patch(job._id, pendingJob)
        return syncAttentionRecord(ctx, "workgraph_due_jobs", pendingJob)
      }
      return ctx.db.insert("workgraph_due_jobs", {
        organization_id: proposal.organization_id,
        owner_user_id: proposal.owner_user_id,
        id,
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
    }),
  )
}

export const markSourcePlanSession = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    workspace_id: v.string(),
    session_id: v.string(),
    admission_confirmed: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await sourcePlanJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    if (!job || job.status !== "running" || job.claimed_by !== args.worker_id || job.lease_epoch !== args.lease_epoch)
      return { settled: false }
    await ctx.db.patch(job._id, {
      payload: {
        ...(job.payload as object),
        workspaceId: args.workspace_id,
        sessionId: args.session_id,
        sessionAdmissionConfirmed: args.admission_confirmed,
      },
      updated_at: args.now,
    })
    if (!args.admission_confirmed) {
      const source = await sourcePlanSource(ctx, job)
      if (!source) return { settled: false }
      const attempt =
        (typeof source.proposal.generation?.attempt === "number" ? source.proposal.generation.attempt : 0) + 1
      const version = source.proposal.row_version + 1
      await ctx.db.patch(source.proposal._id, {
        generation: {
          method: "planning",
          attempt,
          queuedAt: source.proposal.generation?.queuedAt ?? args.now,
          startedAt: args.now,
        },
        row_version: version,
        updated_at: args.now,
      })
      await appendSourcePlanChange(ctx, source, version, { method: "planning", attempt }, args.now)
    }
    return { settled: true }
  },
})

export const retrySourcePlanLaunch = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    worker_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await sourcePlanJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    if (!job || job.status !== "running" || job.claimed_by !== args.worker_id || job.lease_epoch !== args.lease_epoch)
      return { settled: false }
    await settleSourcePlanFailure(ctx, job, args.reason, true, "failed", args.now)
    return { settled: true }
  },
})

export const listRunningSourcePlans = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_user_id: v.id("users"), limit: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("workgraph_due_jobs")
      .withIndex("by_tenant", (query: any) =>
        query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
      )
      .filter((query) =>
        query.and(query.eq(query.field("job_type"), "source_plan"), query.eq(query.field("status"), "running")),
      )
      .take(Math.max(1, Math.min(10, args.limit)))
    return (
      await Promise.all(
        jobs.map(async (job) => {
          const payload = job.payload as { workspaceId?: string; sessionId?: string }
          const confirmed = (job.payload as { sessionAdmissionConfirmed?: unknown }).sessionAdmissionConfirmed === true
          return confirmed && payload.workspaceId && payload.sessionId && job.organization_id
            ? {
                ownerUserId: String(job.owner_user_id),
                orgId: String(job.organization_id),
                jobId: job.id,
                leaseEpoch: job.lease_epoch,
                workspaceId: payload.workspaceId,
                sessionId: payload.sessionId,
                activeLeaseAgeMs: Math.max(0, args.now - (job.updated_at ?? args.now)),
                expiredRecovery: (job.claim_expires_at ?? Number.MAX_SAFE_INTEGER) <= args.now,
              }
            : null
        }),
      )
    ).filter((job) => job !== null)
  },
})

export const completeSourcePlan = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    plan: v.any(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await sourcePlanJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    const payload = job?.payload as
      | {
          sessionId?: string
          proposalId?: string
          source?: { work_source_id?: string; revision_id?: string; content_hash?: string }
        }
      | undefined
    if (
      !job ||
      job.status !== "running" ||
      job.lease_epoch !== args.lease_epoch ||
      payload?.sessionId !== args.session_id
    )
      return { settled: false }
    const source = await sourcePlanSource(ctx, job)
    if (!source) {
      await settleSourcePlanFailure(
        ctx,
        job,
        "Source revision or proposal is no longer current",
        false,
        "cancelled",
        args.now,
      )
      return { settled: false }
    }
    const plan = AdmissionAgentPlanSchema.parse(args.plan)
    const sourceRef = payload.source
    if (
      !sourceRef ||
      plan.source.workSourceId !== sourceRef.work_source_id ||
      plan.source.revisionId !== sourceRef.revision_id ||
      plan.source.contentHash !== sourceRef.content_hash
    )
      throw new Error("Source planning result did not echo the exact immutable source revision")
    const targetStreamId = source.proposal.planning_evidence?.targetStreamId
    if (
      typeof targetStreamId === "string" &&
      (plan.suggestedPlacement.mode !== "existing" || plan.suggestedPlacement.streamId !== targetStreamId)
    ) {
      await settleSourcePlanFailure(
        ctx,
        job,
        "Source planning result did not honor the exact target Stream",
        true,
        "failed",
        args.now,
      )
      return { settled: true }
    }
    const outcomeKeys = plan.proposedOutcomes.map((outcome) => outcome.key)
    const itemKeys = plan.proposedWorkItems.map((item) => item.key)
    if (
      new Set(outcomeKeys).size !== outcomeKeys.length ||
      new Set(itemKeys).size !== itemKeys.length ||
      plan.proposedWorkItems.some(
        (item) =>
          (item.outcomeKey && !outcomeKeys.includes(item.outcomeKey)) ||
          item.dependencyKeys.some((key) => !itemKeys.includes(key) || key === item.key),
      )
    )
      throw new Error("Source planning result contains invalid proposal references")
    if (
      sourcePlanDependencyCycle(
        plan.proposedWorkItems.map((item) => ({ key: item.key, dependencies: item.dependencyKeys })),
      )
    )
      throw new Error("Source planning result contains a dependency cycle")
    const streamIds = [
      ...new Set([
        ...(plan.suggestedPlacement.mode === "existing" ? [plan.suggestedPlacement.streamId] : []),
        ...plan.placementMatches.map((match) => match.streamId),
        ...plan.duplicateMatches.map((match) => match.streamId),
      ]),
    ]
    const allowedStreamIds = new Set<string>(
      [
        ...(source.proposal.planning_evidence?.targetStreamId
          ? [source.proposal.planning_evidence.targetStreamId]
          : []),
        ...(source.proposal.planning_evidence?.placementMatches ?? []).map(
          (match: { streamId?: string; stream_id?: string }) => match.streamId ?? match.stream_id,
        ),
      ].filter((id): id is string => typeof id === "string"),
    )
    if (streamIds.some((id) => !allowedStreamIds.has(id)))
      throw new Error("Source planning result referenced a Stream outside its bounded evidence package")
    const streams = await Promise.all(
      streamIds.map((id) =>
        ctx.db
          .query("workgraph_streams")
          .withIndex("by_tenant_id", (query: any) =>
            query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
          )
          .filter((query) =>
            query.and(query.eq(query.field("organization_id"), args.organization_id), query.eq(query.field("id"), id)),
          )
          .unique(),
      ),
    )
    if (streams.some((stream) => !stream)) throw new Error("Source planning result referenced an unavailable Stream")
    const allowedDuplicates = new Set<string>(
      (source.proposal.planning_evidence?.duplicateMatches ?? []).flatMap(
        (match: { subject?: Record<string, unknown> }) => {
          if (match.subject?.type === "outcome" && typeof match.subject.outcomeId === "string")
            return [`outcome:${match.subject.outcomeId}`]
          if (match.subject?.type === "work_item" && typeof match.subject.workItemId === "string")
            return [`work_item:${match.subject.workItemId}`]
          return []
        },
      ),
    )
    for (const match of plan.duplicateMatches) {
      const id = match.subject.type === "outcome" ? match.subject.outcomeId : match.subject.workItemId
      if (!allowedDuplicates.has(`${match.subject.type}:${id}`))
        throw new Error("Source planning result contained duplicate evidence outside its bounded package")
      const table = match.subject.type === "outcome" ? "workgraph_outcomes" : "workgraph_work_items"
      const record = await ctx.db
        .query(table)
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", args.organization_id).eq("owner_user_id", args.owner_user_id),
        )
        .filter((query) =>
          query.and(query.eq(query.field("organization_id"), args.organization_id), query.eq(query.field("id"), id)),
        )
        .unique()
      if (!record || record.stream_id !== match.streamId)
        throw new Error("Source planning result contained unsupported duplicate evidence")
    }
    const version = source.proposal.row_version + 1
    const proposed = {
      ...source.proposal,
      state: "proposed",
      generation: { method: "agent_session", sessionId: args.session_id, generatedAt: args.now },
      suggested_placement: plan.suggestedPlacement,
      placement_matches: plan.placementMatches,
      proposed_outcomes: plan.proposedOutcomes,
      proposed_work_items: plan.proposedWorkItems,
      duplicate_matches: plan.duplicateMatches,
      row_version: source.proposal.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(source.proposal._id, proposed)
    await syncAttentionRecord(ctx, "workgraph_admission_proposals", proposed)
    await appendSourcePlanChange(
      ctx,
      source,
      version,
      { method: "agent_session", sessionId: args.session_id },
      args.now,
    )
    const completedJob = {
      ...job,
      status: "completed",
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: undefined,
      row_version: job.row_version + 1,
      updated_at: args.now,
    }
    await ctx.db.patch(job._id, completedJob)
    await syncAttentionRecord(ctx, "workgraph_due_jobs", completedJob)
    return { settled: true }
  },
})

export const failSourcePlan = serviceMutation({
  args: {
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    job_id: v.string(),
    lease_epoch: v.number(),
    session_id: v.string(),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.organization_id, args.owner_user_id)
    const job = await sourcePlanJob(ctx, args.organization_id, args.owner_user_id, args.job_id)
    const payload = job?.payload as { sessionId?: string } | undefined
    if (
      !job ||
      job.status !== "running" ||
      job.lease_epoch !== args.lease_epoch ||
      payload?.sessionId !== args.session_id
    )
      return { settled: false }
    await settleSourcePlanFailure(ctx, job, args.reason, true, "failed", args.now)
    return { settled: true }
  },
})

async function settleSourcePlanFailure(
  ctx: Ctx,
  job: Doc<"workgraph_due_jobs">,
  reason: string,
  retryable: boolean,
  status: "failed" | "cancelled",
  now: number,
  configurationRequirement?: {
    type: "generation"
    purpose: "source_planning"
    scope: { type: "workgraph" }
  },
) {
  const payload = job.payload as {
    proposalId?: string
    source?: { work_source_id?: string; revision_id?: string; content_hash?: string }
    automaticFailureCount?: number
  }
  const proposal = payload.proposalId
    ? await ctx.db
        .query("workgraph_admission_proposals")
        .withIndex("by_tenant_id", (query: any) =>
          query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
        )
        .filter((query) =>
          query.and(
            query.eq(query.field("organization_id"), job.organization_id),
            query.eq(query.field("id"), payload.proposalId),
          ),
        )
        .unique()
    : undefined
  if (proposal && ["planning", "planning_failed"].includes(proposal.state)) {
    const attempt = typeof proposal.generation?.attempt === "number" ? proposal.generation.attempt : 0
    const version = proposal.row_version + 1
    await ctx.db.patch(proposal._id, {
      state: "planning_failed",
      generation: { method: "planning_failed", attempt, reason, failedAt: now, retryable },
      suggested_placement: undefined,
      placement_matches: undefined,
      proposed_outcomes: undefined,
      proposed_work_items: undefined,
      duplicate_matches: undefined,
      row_version: version,
      updated_at: now,
    })
    if (typeof payload.source?.work_source_id === "string" && payload.source.work_source_id.trim()) {
      await appendSourcePlanChange(
        ctx,
        {
          proposal,
          workSource: { id: payload.source.work_source_id },
        },
        version,
        { method: "planning_failed", attempt, reason, retryable },
        now,
      )
    }
  }
  const automaticFailureCount = (payload.automaticFailureCount ?? 0) + 1
  const retryScheduled = retryable && automaticFailureCount < 3
  const failedJob = {
    ...job,
    status: retryScheduled ? status : retryable ? "failed_terminal" : status,
    due_at: retryScheduled ? now + retryDelay : now,
    payload: {
      proposalId: payload.proposalId,
      source: payload.source,
      automaticFailureCount,
      ...(configurationRequirement ? { configurationRequirement } : {}),
    },
    claimed_by: undefined,
    claim_expires_at: undefined,
    last_error: reason,
    row_version: job.row_version + 1,
    updated_at: now,
  }
  await ctx.db.patch(job._id, failedJob)
  await syncAttentionRecord(ctx, "workgraph_due_jobs", failedJob)
}

async function rejectRecapConfiguration(
  ctx: Ctx,
  job: Doc<"workgraph_due_jobs">,
  payload: Record<string, unknown>,
  streamId: string,
  reason: string,
  now: number,
) {
  const automaticFailureCount = Number(payload.automaticFailureCount ?? 0) + 1
  const exhausted = automaticFailureCount >= 3
  const failedJob = {
    ...job,
    status: exhausted ? "failed" : "pending",
    due_at: now + retryDelay,
    payload: {
      ...payload,
      automaticFailureCount,
      configurationRequirement: {
        type: "generation",
        purpose: "recap",
        scope: { type: "stream", streamId },
      },
    },
    claimed_by: undefined,
    claim_expires_at: undefined,
    last_error: reason,
    row_version: job.row_version + 1,
    updated_at: now,
  }
  await ctx.db.patch(job._id, failedJob)
  await syncAttentionRecord(ctx, "workgraph_due_jobs", failedJob)
  if (exhausted && job.organization_id) {
    await markRecapAttention(ctx, job.organization_id, job.owner_user_id, streamId, reason, now)
  }
}

function generationProfileError(
  purpose: "Recap" | "Source planning",
  profile: { agent?: string; model?: { providerId?: string; modelId?: string }; effort?: string } | undefined,
) {
  if (typeof profile?.agent !== "string" || !profile.agent.trim())
    return `${purpose} requires explicit valid agent configuration`
  if (
    typeof profile.model?.providerId !== "string" ||
    !profile.model.providerId.trim() ||
    typeof profile.model.modelId !== "string" ||
    !profile.model.modelId.trim()
  ) {
    return `${purpose} requires explicit valid model configuration`
  }
  if (typeof profile.effort !== "string" || !profile.effort.trim())
    return `${purpose} requires explicit valid effort configuration`
  return undefined
}

function explicitStreamRecapConfiguration(value: unknown, execution?: unknown) {
  const parsed = RecapProfileDefaultsSchema.safeParse(value ?? {})
  const parsedExecution = ExecutionProfileDefaultsSchema.safeParse(execution ?? {})
  const resolved = parsed.success && parsedExecution.success
    ? resolveRecapProfileDefaults({ recap: parsed.data, execution: parsedExecution.data })
    : undefined
  if (!resolved) {
    return {
      ok: false as const,
      error: "Recap requires explicit Stream model, effort, and quietHours configuration",
    }
  }
  return { ok: true as const, value: resolved }
}

function recapConfigurationRequirement(streamId: string) {
  return {
    type: "generation" as const,
    purpose: "recap" as const,
    scope: { type: "stream" as const, streamId },
  }
}

function appendSourcePlanChange(
  ctx: Ctx,
  source: {
    proposal: { id: string; organization_id?: Id<"orgs">; owner_user_id: unknown }
    workSource: { id: string }
  },
  version: number,
  generation: Record<string, unknown>,
  now: number,
) {
  if (!source.proposal.organization_id) throw new Error("WorkGraph organization is required")
  return appendSystemWorkGraphChange(ctx, {
    organizationId: String(source.proposal.organization_id),
    ownerUserId: String(source.proposal.owner_user_id),
    operationId: `source_plan_publish_${source.proposal.id}_${version}`,
    eventId: `event_source_plan_publish_${source.proposal.id}_${version}`,
    changeId: `change_source_plan_publish_${source.proposal.id}_${version}`,
    resourceType: "admission_proposal",
    resourceId: source.proposal.id,
    changeType: "admission_proposal_updated",
    payload: { proposalId: source.proposal.id, workSourceId: source.workSource.id, version, generation },
    actorId: "source_planner",
    now,
  })
}

async function sourcePlanSource(ctx: Ctx, job: Doc<"workgraph_due_jobs">) {
  if (!job.organization_id) return undefined
  const payload = job.payload as {
    proposalId?: string
    source?: { work_source_id?: string; revision_id?: string; content_hash?: string }
  }
  if (
    !payload.proposalId ||
    !payload.source?.work_source_id ||
    !payload.source.revision_id ||
    !payload.source.content_hash
  )
    return undefined
  const proposal = await ctx.db
    .query("workgraph_admission_proposals")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), job.organization_id),
        query.eq(query.field("id"), payload.proposalId),
      ),
    )
    .unique()
  const workSource = await ctx.db
    .query("work_sources")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), job.organization_id),
        query.eq(query.field("id"), payload.source!.work_source_id),
      ),
    )
    .unique()
  const revision = await ctx.db
    .query("work_source_revisions")
    .withIndex("by_tenant_id", (query: any) =>
      query.eq("organization_id", job.organization_id).eq("owner_user_id", job.owner_user_id),
    )
    .filter((query) =>
      query.and(
        query.eq(query.field("organization_id"), job.organization_id),
        query.eq(query.field("id"), payload.source!.revision_id),
      ),
    )
    .unique()
  if (
    !proposal ||
    !["planning", "planning_failed"].includes(proposal.state) ||
    proposal.source?.revision_id !== payload.source.revision_id ||
    !workSource ||
    workSource.latest_revision_id !== payload.source.revision_id ||
    !revision ||
    revision.work_source_id !== payload.source.work_source_id ||
    revision.content_hash !== payload.source.content_hash
  )
    return undefined
  return {
    proposal,
    workSource,
    revision,
    reference: {
      workSourceId: payload.source.work_source_id,
      revisionId: payload.source.revision_id,
      contentHash: payload.source.content_hash,
    },
  }
}

function sourcePlanJob(ctx: Ctx, organization: Id<"orgs">, owner: Id<"users">, id: string) {
  return ctx.db
    .query("workgraph_due_jobs")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query) =>
      query.and(query.eq(query.field("organization_id"), organization), query.eq(query.field("id"), id)),
    )
    .unique()
}

function sourcePlanDependencyCycle(items: ReadonlyArray<Readonly<{ key: string; dependencies: readonly string[] }>>) {
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

function recapJob(ctx: Ctx, organization: Id<"orgs">, owner: Id<"users">, id: string) {
  return ctx.db
    .query("workgraph_due_jobs")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", organization).eq("owner_user_id", owner))
    .filter((query) =>
      query.and(query.eq(query.field("organization_id"), organization), query.eq(query.field("id"), id)),
    )
    .unique()
}
