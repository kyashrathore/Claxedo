import { v } from "convex/values"
import { isMasterSessionId, MASTER_ATTEMPT_PREFIX, masterSessionId } from "@claxedo/workgraph/contracts"
import type { GenericMutationCtx } from "convex/server"
import type { DataModel, Id } from "./_generated/dataModel"
import { serviceMutation, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, assertWorkGraphOwnerWritable } from "./workgraphModel"
import { syncConnectionAttention } from "./workgraphAttention"
import { appendSystemWorkGraphChange, applyWorkGraphCommand } from "./workgraphCommands"

const integrationId = v.union(v.literal("github"), v.literal("linear"), v.literal("jira"))
const status = v.union(v.literal("connected"), v.literal("degraded"), v.literal("broken"))
const tokenType = v.union(v.literal("bearer"), v.literal("basic"))
const capabilities = new Set(["docs", "work-source", "channel", "code-host"])
const connectionTools = new Set([
  "connection_work_source_list",
  "connection_work_source_comment",
  "connection_work_source_update",
  "connection_code_host_open_pr",
])
const metadataFields = {
  github: new Set(["installation_id"]),
  linear: new Set(["team_id"]),
  jira: new Set(["site_url", "email", "cloud_id"]),
}

export const upsertMetadata = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    connectionId: v.string(),
    integrationId,
    capabilities: v.array(v.string()),
    status,
    accountLabel: v.optional(v.string()),
    fields: v.optional(v.record(v.string(), v.string())),
    tokenType: v.optional(tokenType),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    const connectionId = required(args.connectionId, "connectionId")
    const granted = unique(args.capabilities.map((capability) => required(capability, "capability")))
    if (granted.some((capability) => !capabilities.has(capability))) throw new Error("Unsupported Connection capability")
    const fields = cleanFields(args.integrationId, args.fields)
    if (args.accountLabel && secretValue(args.accountLabel.trim())) throw new Error("Connection metadata cannot contain credential material")
    const matching = await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_connection", (query: any) => query.eq("connection_id", connectionId))
      .take(2)
    if (matching.some((row: any) => row.organization_id !== args.orgId)) throw new Error("Connection belongs to another org")
    const existing = await connectionMetadata(ctx, args.orgId, connectionId)
    if (existing && existing.integration_id !== args.integrationId) throw new Error("Connection integration cannot change")
    const now = Date.now()
    const value = {
      integration_id: args.integrationId,
      capabilities: granted,
      status: args.status,
      ...(args.accountLabel?.trim() ? { account_label: args.accountLabel.trim() } : { account_label: undefined }),
      ...(fields ? { fields } : { fields: undefined }),
      ...(args.tokenType ? { token_type: args.tokenType } : { token_type: undefined }),
      updated_at: now,
    }
    if (existing) {
      const saved = { ...existing, ...value, row_version: existing.row_version + 1 }
      await ctx.db.patch(existing._id, saved)
      await syncConnectionAttention(ctx, String(args.orgId), connectionId, saved.status, saved.updated_at)
      return metadataResult(saved)
    }
    const saved = {
      organization_id: args.orgId,
      connection_id: connectionId,
      ...value,
      row_version: 1,
      schema_version: 1,
      created_at: now,
    }
    await ctx.db.insert("workgraph_connection_metadata", saved)
    await syncConnectionAttention(ctx, String(args.orgId), connectionId, saved.status, saved.updated_at)
    return metadataResult(saved)
  },
})

export const listMetadata = serviceQuery({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
  },
  handler: async (ctx, args) => {
    if (!await isOrgMember(ctx, args.ownerUserId, args.orgId)) return []
    return (await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_organization_connection", (query: any) => query.eq("organization_id", args.orgId))
      .collect())
      .map(metadataResult)
  },
})

/** Host-internal webhook lookup. Connection IDs are generated global IDs;
 * duplicate rows fail closed rather than choosing an arbitrary tenant. No
 * credential bytes are stored or returned here. */
export const resolveWebhookMetadata = serviceQuery({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_connection", (query: any) => query.eq("connection_id", required(args.connectionId, "connectionId")))
      .take(2)
    if (rows.length !== 1) return null
    const row = rows[0]
    if (!row || row.status !== "connected" || !row.capabilities.includes("work-source")) return null
    return metadataResult(row)
  },
})

export const deleteMetadata = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    connectionId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    const existing = await connectionMetadata(ctx, args.orgId, required(args.connectionId, "connectionId"))
    if (!existing) return { deleted: false as const }
    await syncConnectionAttention(ctx, String(args.orgId), existing.connection_id, "connected", Date.now())
    await ctx.db.delete(existing._id)
    return { deleted: true as const }
  },
})

export const bindAttemptConnections = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    attemptId: v.string(),
    sessionId: v.string(),
    workspaceId: v.string(),
    connectionIds: v.array(v.string()),
    tools: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    const attemptId = required(args.attemptId, "attemptId")
    const sessionId = required(args.sessionId, "sessionId")
    const workspaceId = required(args.workspaceId, "workspaceId")
    const connectionIds = unique(args.connectionIds.map((id) => required(id, "connectionId")))
    const tools = unique(args.tools.map((tool) => required(tool, "tool")))
    if (!connectionIds.length || !tools.length) throw new Error("Connection binding requires connections and tools")
    if (tools.some((tool) => !connectionTools.has(tool))) throw new Error("Unsupported Connection operation tool")
    const attempt = await ownedAttempt(ctx, args.orgId, args.ownerUserId, attemptId)
    const master = attempt ? undefined : await ownedMasterStream(ctx, args.orgId, args.ownerUserId, attemptId, sessionId)
    if ((!attempt || attempt.session_id !== sessionId || attempt.envelope_id !== workspaceId || attempt.state !== "running") && !master) {
      throw new Error("Attempt placement does not match the Connection binding")
    }
    const profile = (attempt?.resolved_execution ?? master?.execution_defaults) as { connectionIds?: unknown; tools?: unknown }
    if (!sameSet(connectionIds, strings(profile.connectionIds)) || !tools.every((tool) => strings(profile.tools).includes(tool))) {
      throw new Error("Connection binding exceeds the immutable Attempt profile")
    }
    const metadata = await Promise.all(connectionIds.map((id) => connectionMetadata(ctx, args.orgId, id)))
    const requiredCapabilities = new Set(tools.map((tool) => tool === "connection_code_host_open_pr" ? "code-host" : "work-source"))
    if (metadata.some((connection) => !connection || connection.status !== "connected" ||
      [...requiredCapabilities].some((capability) => !connection.capabilities.includes(capability)))) {
      throw new Error("Connection metadata is unavailable")
    }
    const existing = await attemptBinding(ctx, args.orgId, args.ownerUserId, attemptId)
    const now = Date.now()
    const value = {
      session_id: sessionId,
      workspace_id: workspaceId,
      connection_ids: connectionIds,
      tools,
      revoked_at: undefined,
      updated_at: now,
    }
    if (existing) {
      await ctx.db.patch(existing._id, { ...value, row_version: existing.row_version + 1 })
      return { bound: true as const }
    }
    await ctx.db.insert("workgraph_attempt_connection_bindings", {
      organization_id: args.orgId,
      owner_user_id: args.ownerUserId,
      attempt_id: attemptId,
      ...value,
      row_version: 1,
      schema_version: 1,
      created_at: now,
    })
    return { bound: true as const }
  },
})

export const resolveOperationBinding = serviceQuery({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    attemptId: v.string(),
    sessionId: v.string(),
    workspaceId: v.string(),
    connectionId: v.string(),
    tool: v.string(),
  },
  handler: async (ctx, args) => {
    if (!await isOrgMember(ctx, args.ownerUserId, args.orgId)) return null
    await assertWorkGraphOwnerReadable(ctx, args.orgId, args.ownerUserId)
    const binding = await attemptBinding(ctx, args.orgId, args.ownerUserId, args.attemptId)
    if (!binding || binding.revoked_at || binding.organization_id !== args.orgId || binding.session_id !== args.sessionId ||
      binding.workspace_id !== args.workspaceId || !binding.connection_ids.includes(args.connectionId) ||
      !binding.tools.includes(args.tool)) return null
    const attempt = await ownedAttempt(ctx, args.orgId, args.ownerUserId, args.attemptId)
    const master = attempt ? undefined : await ownedMasterStream(ctx, args.orgId, args.ownerUserId, args.attemptId, args.sessionId)
    if ((!attempt || attempt.state !== "running" || attempt.session_id !== args.sessionId || attempt.envelope_id !== args.workspaceId) && !master) return null
    const connection = await connectionMetadata(ctx, args.orgId, args.connectionId)
    const capability = args.tool === "connection_code_host_open_pr" ? "code-host" : "work-source"
    if (!connection || connection.status !== "connected" || !connection.capabilities.includes(capability)) return null
    return {
      context: { ownerUserId: String(args.ownerUserId), ownerPartition: `org:${String(args.orgId)}` },
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      workspaceId: binding.workspace_id,
      connectionIds: binding.connection_ids,
      tools: binding.tools,
      ...(master ? { streamId: master.id } : { streamId: attempt!.stream_id }),
      connection: metadataResult(connection),
    }
  },
})

export const recordPullRequestReceipt = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    streamId: v.string(),
    attemptId: v.string(),
    idempotencyKey: v.string(),
    pullRequestId: v.string(),
    url: v.string(),
    draft: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    const existing = await ctx.db.query("workgraph_durable_effect_receipts")
      .withIndex("by_tenant_idempotency", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("idempotency_key", args.idempotencyKey))
      .unique()
    if (existing) return { durableEffectReceiptId: existing.id, recorded: false as const }
    const attempt = await ctx.db.query("workgraph_attempts")
      .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("id", args.attemptId))
      .unique()
    const master = attempt ? undefined : await ownedMasterStream(
      ctx,
      args.orgId,
      args.ownerUserId,
      args.attemptId,
      masterSessionId(args.streamId),
    )
    if ((!attempt || attempt.state !== "running" || attempt.stream_id !== args.streamId) && !master) {
      throw new Error("Pull request receipt requires an active WorkGraph execution")
    }
    return persistPullRequestReceipt(ctx, { ...args, now: Date.now() })
  },
})

export const claimPullRequestEffect = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    streamId: v.string(),
    attemptId: v.string(),
    workerId: v.string(),
    idempotencyKey: v.string(),
    repository: v.string(),
    head: v.string(),
    base: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    draft: v.boolean(),
    publicRepository: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    const existing = await ctx.db.query("workgraph_outbox")
      .withIndex("by_tenant_idempotency", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("idempotency_key", args.idempotencyKey))
      .unique()
    if (existing?.status === "completed") {
      const result = (existing.payload as { result?: unknown }).result
      if (!result) throw new Error("Completed pull request effect is missing its result")
      return { state: "completed" as const, result }
    }
    if (existing?.status === "claimed" && Number(existing.claim_expires_at) > args.now) {
      return { state: "busy" as const }
    }
    const attempt = await ctx.db.query("workgraph_attempts")
      .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("id", args.attemptId))
      .unique()
    const master = attempt ? undefined : await ownedMasterStream(
      ctx,
      args.orgId,
      args.ownerUserId,
      args.attemptId,
      masterSessionId(args.streamId),
    )
    if ((!attempt || attempt.state !== "running" || attempt.stream_id !== args.streamId) && !master) {
      throw new Error("Pull request effect requires an active WorkGraph execution")
    }
    const payload = {
      streamId: args.streamId,
      attemptId: args.attemptId,
      repository: args.repository,
      head: args.head,
      base: args.base,
      title: args.title,
      ...(args.body === undefined ? {} : { body: args.body }),
      draft: args.draft,
      publicRepository: args.publicRepository,
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        payload,
        status: "claimed",
        claimed_by: args.workerId,
        claim_expires_at: args.now + 60_000,
        attempt_count: existing.attempt_count + 1,
        last_error: undefined,
        updated_at: args.now,
      })
      return { state: "claimed" as const, outboxId: existing.id }
    }
    const outboxId = `outbox_pr_${crypto.randomUUID()}`
    await ctx.db.insert("workgraph_outbox", {
      organization_id: args.orgId,
      owner_user_id: args.ownerUserId,
      id: outboxId,
      operation_id: `pull_request_${args.idempotencyKey}`,
      stream_id: args.streamId,
      effect_type: "open_pull_request",
      idempotency_key: args.idempotencyKey,
      payload,
      status: "claimed",
      available_at: args.now,
      attempt_count: 1,
      claimed_by: args.workerId,
      claim_expires_at: args.now + 60_000,
      schema_version: 1,
      created_at: args.now,
      updated_at: args.now,
    })
    return { state: "claimed" as const, outboxId }
  },
})

export const completePullRequestEffect = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    outboxId: v.string(),
    workerId: v.string(),
    pullRequestId: v.string(),
    url: v.string(),
    draft: v.boolean(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    const outbox = await ctx.db.query("workgraph_outbox")
      .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("id", args.outboxId))
      .unique()
    if (!outbox || outbox.effect_type !== "open_pull_request") throw new Error("Pull request effect is unavailable")
    if (outbox.status === "completed") return (outbox.payload as { result: unknown }).result
    if (outbox.status !== "claimed" || outbox.claimed_by !== args.workerId) {
      throw new Error("Pull request effect lease is no longer owned by this worker")
    }
    const payload = outbox.payload as { streamId: string; attemptId: string; draft: boolean }
    const receipt = await persistPullRequestReceipt(ctx, {
      ownerUserId: args.ownerUserId,
      orgId: args.orgId,
      streamId: payload.streamId,
      attemptId: payload.attemptId,
      idempotencyKey: outbox.idempotency_key,
      pullRequestId: args.pullRequestId,
      url: args.url,
      draft: args.draft,
      now: args.now,
    })
    const result = {
      type: "open_pull_request" as const,
      pullRequestId: args.pullRequestId,
      url: args.url,
      draft: args.draft,
      durableEffectReceiptId: receipt.durableEffectReceiptId,
      evidenceId: receipt.evidenceId,
    }
    await ctx.db.patch(outbox._id, {
      payload: { ...payload, result },
      status: "completed",
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: undefined,
      updated_at: args.now,
    })
    return result
  },
})

export const failPullRequestEffect = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    outboxId: v.string(),
    workerId: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    const outbox = await ctx.db.query("workgraph_outbox")
      .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("id", args.outboxId))
      .unique()
    if (!outbox || outbox.status !== "claimed" || outbox.claimed_by !== args.workerId) return { settled: false as const }
    await ctx.db.patch(outbox._id, {
      status: outbox.attempt_count >= 3 ? "failed" : "pending",
      available_at: args.now + Math.min(60_000, 1_000 * 2 ** Math.max(0, outbox.attempt_count - 1)),
      claimed_by: undefined,
      claim_expires_at: undefined,
      last_error: "Pull request provider operation failed",
      updated_at: args.now,
    })
    return { settled: true as const }
  },
})

async function persistPullRequestReceipt(ctx: GenericMutationCtx<DataModel>, args: {
  ownerUserId: Id<"users">
  orgId: Id<"orgs">
  streamId: string
  attemptId: string
  idempotencyKey: string
  pullRequestId: string
  url: string
  draft: boolean
  now: number
}) {
  const stream = await ctx.db.query("workgraph_streams")
    .withIndex("by_tenant_id", (query) => query.eq("organization_id", args.orgId)
      .eq("owner_user_id", args.ownerUserId).eq("id", args.streamId))
    .unique()
  if (!stream) throw new Error("Pull request Stream is unavailable")
  const receiptId = `receipt_pr_${crypto.randomUUID()}`
  const evidenceId = `evidence_pr_${crypto.randomUUID()}`
  const provenance = { actor: { type: "agent", id: args.attemptId } } as const
  await ctx.db.insert("workgraph_durable_effect_receipts", {
    organization_id: args.orgId,
    owner_user_id: args.ownerUserId,
    id: receiptId,
    stream_id: args.streamId,
    effect_kind: "published",
    idempotency_key: args.idempotencyKey,
    external_reference: { url: args.url, pullRequestId: args.pullRequestId, draft: args.draft },
    provenance,
    schema_version: 1,
    created_at: args.now,
  })
  await ctx.db.insert("workgraph_evidence", {
    organization_id: args.orgId,
    owner_user_id: args.ownerUserId,
    id: evidenceId,
    stream_id: args.streamId,
    subject_type: "stream",
    subject_id: args.streamId,
    evidence_kind: "integration",
    summary: `Opened ${args.draft ? "draft " : ""}pull request`,
    reference: { kind: "integration", effect: "published", reference: args.url, durableEffectReceiptId: receiptId },
    provenance,
    schema_version: 1,
    created_at: args.now,
  })
  await ctx.db.patch(stream._id, {
    durable_effect_count: stream.durable_effect_count + 1,
    row_version: stream.row_version + 1,
    updated_at: args.now,
  })
  await appendSystemWorkGraphChange(ctx, {
    organizationId: String(args.orgId),
    ownerUserId: String(args.ownerUserId),
    operationId: `pull_request_${receiptId}`,
    eventId: `event_pull_request_${receiptId}`,
    changeId: `change_pull_request_${receiptId}`,
    resourceType: "stream",
    resourceId: args.streamId,
    changeType: "master_audit_recorded",
    payload: { streamId: args.streamId, evidenceId, durableEffectReceiptId: receiptId, url: args.url, draft: args.draft },
    actorId: args.attemptId,
    now: args.now,
  })
  return { durableEffectReceiptId: receiptId, evidenceId, recorded: true as const }
}

export const authorizePullRequest = serviceMutation({
  args: {
    ownerUserId: v.id("users"),
    orgId: v.id("orgs"),
    streamId: v.string(),
    attemptId: v.string(),
    repository: v.string(),
    title: v.string(),
    draft: v.boolean(),
    publicRepository: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOrgMember(ctx, args.ownerUserId, args.orgId)
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    if (args.draft || !args.publicRepository) return { allowed: true as const }
    const stream = await ctx.db.query("workgraph_streams")
      .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", args.orgId)
        .eq("owner_user_id", args.ownerUserId).eq("id", args.streamId))
      .unique()
    if (!stream) throw new Error("Pull request Stream is unavailable")
    if (stream.public_pr_confirmed_at !== undefined) return { allowed: true as const }
    const sessionId = masterSessionId(stream.id)
    if (args.attemptId !== `master_${stream.id}` || stream.master_status?.sessionId !== sessionId) {
      throw new Error("Only the Stream master can request public PR confirmation")
    }
    // Idempotent-by-design: an already-pending confirmation is a success
    // no-op inside the command, so every call gets a fresh operation id.
    // Any command failure denies — an unconfirmed public PR never proceeds
    // on an error path.
    const operationId = `public_pr_confirmation_${stream.id}_${crypto.randomUUID()}`
    const result = await applyWorkGraphCommand(ctx, {
      organizationId: String(args.orgId),
      ownerUserId: String(args.ownerUserId),
      ownerSubject: String(args.ownerUserId),
      actor: { type: "agent", id: sessionId },
      requestId: operationId,
      operationId,
      command: {
        version: 1,
        type: "request_public_pr_confirmation",
        streamId: stream.id,
        expectedVersion: stream.row_version,
        repository: args.repository,
        title: args.title,
      },
    })
    if (!result.ok) {
      console.error("[convex] WARN public PR confirmation request failed:", result.error.message)
    }
    return { allowed: false as const }
  },
})

export const revokeAttemptBinding = serviceMutation({
  args: { ownerUserId: v.id("users"), orgId: v.id("orgs"), attemptId: v.string() },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.orgId, args.ownerUserId)
    const binding = await attemptBinding(ctx, args.orgId, args.ownerUserId, required(args.attemptId, "attemptId"))
    if (!binding || binding.revoked_at) return { revoked: false as const }
    await ctx.db.patch(binding._id, {
      revoked_at: Date.now(),
      row_version: binding.row_version + 1,
      updated_at: Date.now(),
    })
    return { revoked: true as const }
  },
})

function metadataResult(row: any) {
  return {
    id: row.connection_id,
    integrationId: row.integration_id,
    capabilities: row.capabilities,
    status: row.status,
    ...(row.account_label ? { accountLabel: row.account_label } : {}),
    ...(row.fields ? { fields: row.fields } : {}),
    ...(row.token_type ? { tokenType: row.token_type } : {}),
    orgId: String(row.organization_id),
  }
}

function connectionMetadata(ctx: any, orgId: string, connectionId: string) {
  return ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_organization_connection", (query: any) => query.eq("organization_id", orgId).eq("connection_id", connectionId))
    .unique()
}

function attemptBinding(ctx: any, orgId: string, ownerUserId: string, attemptId: string) {
  return ctx.db.query("workgraph_attempt_connection_bindings")
    .withIndex("by_tenant_attempt", (query: any) => query.eq("organization_id", orgId).eq("owner_user_id", ownerUserId).eq("attempt_id", attemptId))
    .unique()
}

function ownedAttempt(ctx: any, orgId: string, ownerUserId: string, attemptId: string) {
  return ctx.db.query("workgraph_attempts")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", orgId).eq("owner_user_id", ownerUserId).eq("id", attemptId))
    .unique()
}

async function ownedMasterStream(ctx: any, orgId: string, ownerUserId: string, attemptId: string, sessionId: string) {
  if (!attemptId.startsWith(MASTER_ATTEMPT_PREFIX) || !isMasterSessionId(sessionId)) return
  const streamId = attemptId.slice("master_".length)
  if (sessionId !== masterSessionId(streamId)) return
  const stream = await ctx.db.query("workgraph_streams")
    .withIndex("by_tenant_id", (query: any) => query.eq("organization_id", orgId).eq("owner_user_id", ownerUserId).eq("id", streamId))
    .unique()
  return stream && stream.master_status?.sessionId === sessionId && ["pending", "acting"].includes(stream.master_status.state)
    ? stream
    : undefined
}

async function requireOrgMember(ctx: any, ownerUserId: string, orgId: string) {
  if (!await isOrgMember(ctx, ownerUserId, orgId)) throw new Error("WorkGraph owner is not an org member")
}

async function isOrgMember(ctx: any, ownerUserId: string, orgId: string) {
  return !!await ctx.db.query("org_memberships")
    .withIndex("by_org_user", (query: any) => query.eq("org_id", orgId).eq("user_id", ownerUserId))
    .unique()
}

function cleanFields(integration: "github" | "linear" | "jira", fields: Record<string, string> | undefined) {
  if (!fields) return
  const cleaned = Object.fromEntries(Object.entries(fields).flatMap(([rawKey, rawValue]) => {
    const key = rawKey.trim()
    const value = rawValue.trim()
    if (!key || !value) return []
    if (secretKey(key) || secretValue(value)) throw new Error("Connection metadata cannot contain credential material")
    if (!metadataFields[integration].has(key)) throw new Error(`Unsupported ${integration} Connection metadata field`)
    if (!validMetadataValue(key, value)) throw new Error(`Invalid ${integration} Connection metadata field`)
    return [[key, value]]
  }))
  return Object.keys(cleaned).length ? cleaned : undefined
}

function secretKey(key: string) {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "")
  return /credential|password|secret|token|authorization|cookie|passphrase/.test(normalized)
    || /(?:access|api|auth|bearer|client|private|refresh|session)key/.test(normalized)
}

function secretValue(value: string) {
  return /^(?:basic|bearer)\s+\S+/i.test(value)
    || /^(?:github_pat_|gh[pousr]_|lin_api_|xox[baprs]-|sk-(?:proj-)?)[A-Za-z0-9_-]{8,}$/i.test(value)
    || /^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)
    || /(?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*\S+/i.test(value)
}

function validMetadataValue(key: string, value: string) {
  if (key === "installation_id") return /^\d{1,30}$/.test(value)
  if (key === "team_id") return /^[A-Za-z0-9_-]{1,100}$/.test(value)
  if (key === "cloud_id") return /^[A-Za-z0-9_-]{1,100}$/.test(value)
  if (key === "email") return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (key === "site_url") {
    try {
      const url = new URL(value)
      return url.protocol === "https:" && !url.username && !url.password && !url.port &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/.test(url.hostname) && url.pathname === "/"
    } catch {
      return false
    }
  }
  return false
}

function required(value: string, name: string) {
  const result = value.trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function sameSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value) => right.includes(value))
}
