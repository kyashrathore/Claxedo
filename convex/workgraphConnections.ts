import { v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, assertWorkGraphOwnerWritable } from "./workgraphModel"
import { removeAttentionRecord, syncAttentionRecord } from "./workgraphAttention"

const integrationId = v.union(v.literal("github"), v.literal("linear"), v.literal("jira"))
const status = v.union(v.literal("connected"), v.literal("degraded"), v.literal("broken"))
const tokenType = v.union(v.literal("bearer"), v.literal("basic"))
const capabilities = new Set(["docs", "work-source", "channel", "code-host"])
const connectionTools = new Set([
  "connection_work_source_list",
  "connection_work_source_comment",
  "connection_work_source_update",
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
    await assertWorkGraphOwnerWritable(ctx, args.ownerUserId)
    const connectionId = required(args.connectionId, "connectionId")
    const granted = unique(args.capabilities.map((capability) => required(capability, "capability")))
    if (granted.some((capability) => !capabilities.has(capability))) throw new Error("Unsupported Connection capability")
    const fields = cleanFields(args.integrationId, args.fields)
    if (args.accountLabel && secretValue(args.accountLabel.trim())) throw new Error("Connection metadata cannot contain credential material")
    const matching = await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_connection", (query: any) => query.eq("connection_id", connectionId))
      .take(2)
    if (matching.some((row: any) => row.org_id !== args.orgId)) throw new Error("Connection belongs to another org")
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
      await syncAttentionRecord(ctx, "workgraph_connection_metadata", saved)
      return metadataResult(saved)
    }
    const saved = {
      owner_user_id: args.ownerUserId,
      org_id: args.orgId,
      connection_id: connectionId,
      ...value,
      row_version: 1,
      schema_version: 1,
      created_at: now,
    }
    await ctx.db.insert("workgraph_connection_metadata", saved)
    await syncAttentionRecord(ctx, "workgraph_connection_metadata", saved)
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
    await assertWorkGraphOwnerReadable(ctx, args.ownerUserId)
    return (await ctx.db.query("workgraph_connection_metadata")
      .withIndex("by_org_connection", (query: any) => query.eq("org_id", args.orgId))
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
    await assertWorkGraphOwnerReadable(ctx, row.owner_user_id)
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
    await assertWorkGraphOwnerWritable(ctx, args.ownerUserId)
    const existing = await connectionMetadata(ctx, args.orgId, required(args.connectionId, "connectionId"))
    if (!existing) return { deleted: false as const }
    await ctx.db.delete(existing._id)
    await removeAttentionRecord(ctx, String(args.ownerUserId), "workgraph_connection_metadata", existing.connection_id)
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
    await assertWorkGraphOwnerWritable(ctx, args.ownerUserId)
    const attemptId = required(args.attemptId, "attemptId")
    const sessionId = required(args.sessionId, "sessionId")
    const workspaceId = required(args.workspaceId, "workspaceId")
    const connectionIds = unique(args.connectionIds.map((id) => required(id, "connectionId")))
    const tools = unique(args.tools.map((tool) => required(tool, "tool")))
    if (!connectionIds.length || !tools.length) throw new Error("Connection binding requires connections and tools")
    if (tools.some((tool) => !connectionTools.has(tool))) throw new Error("Unsupported Connection operation tool")
    const attempt = await ownedAttempt(ctx, args.ownerUserId, attemptId)
    if (!attempt || attempt.session_id !== sessionId || attempt.envelope_id !== workspaceId || attempt.state !== "running") {
      throw new Error("Attempt placement does not match the Connection binding")
    }
    const profile = attempt.resolved_execution as { connectionIds?: unknown; tools?: unknown }
    if (!sameSet(connectionIds, strings(profile.connectionIds)) || !tools.every((tool) => strings(profile.tools).includes(tool))) {
      throw new Error("Connection binding exceeds the immutable Attempt profile")
    }
    const metadata = await Promise.all(connectionIds.map((id) => connectionMetadata(ctx, args.orgId, id)))
    if (metadata.some((connection) => !connection || connection.status !== "connected" || !connection.capabilities.includes("work-source"))) {
      throw new Error("Connection metadata is unavailable")
    }
    const existing = await attemptBinding(ctx, args.ownerUserId, attemptId)
    const now = Date.now()
    const value = {
      org_id: args.orgId,
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
    await assertWorkGraphOwnerReadable(ctx, args.ownerUserId)
    const binding = await attemptBinding(ctx, args.ownerUserId, args.attemptId)
    if (!binding || binding.revoked_at || binding.org_id !== args.orgId || binding.session_id !== args.sessionId ||
      binding.workspace_id !== args.workspaceId || !binding.connection_ids.includes(args.connectionId) ||
      !binding.tools.includes(args.tool)) return null
    const attempt = await ownedAttempt(ctx, args.ownerUserId, args.attemptId)
    if (!attempt || attempt.state !== "running" || attempt.session_id !== args.sessionId || attempt.envelope_id !== args.workspaceId) return null
    const connection = await connectionMetadata(ctx, args.orgId, args.connectionId)
    if (!connection || connection.status !== "connected" || !connection.capabilities.includes("work-source")) return null
    return {
      context: { ownerUserId: String(args.ownerUserId), ownerPartition: `org:${String(args.orgId)}` },
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      workspaceId: binding.workspace_id,
      connectionIds: binding.connection_ids,
      tools: binding.tools,
      connection: metadataResult(connection),
    }
  },
})

export const revokeAttemptBinding = serviceMutation({
  args: { ownerUserId: v.id("users"), attemptId: v.string() },
  handler: async (ctx, args) => {
    await assertWorkGraphOwnerWritable(ctx, args.ownerUserId)
    const binding = await attemptBinding(ctx, args.ownerUserId, required(args.attemptId, "attemptId"))
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
    orgId: String(row.org_id),
  }
}

function connectionMetadata(ctx: any, orgId: string, connectionId: string) {
  return ctx.db.query("workgraph_connection_metadata")
    .withIndex("by_org_connection", (query: any) => query.eq("org_id", orgId).eq("connection_id", connectionId))
    .unique()
}

function attemptBinding(ctx: any, ownerUserId: string, attemptId: string) {
  return ctx.db.query("workgraph_attempt_connection_bindings")
    .withIndex("by_owner_attempt", (query: any) => query.eq("owner_user_id", ownerUserId).eq("attempt_id", attemptId))
    .unique()
}

function ownedAttempt(ctx: any, ownerUserId: string, attemptId: string) {
  return ctx.db.query("workgraph_attempts")
    .withIndex("by_owner_id", (query: any) => query.eq("owner_user_id", ownerUserId).eq("id", attemptId))
    .unique()
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
