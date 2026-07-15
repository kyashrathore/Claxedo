import type { GenericMutationCtx, GenericQueryCtx } from "convex/server"
import { ConvexError, v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"
import { assertWorkGraphOwnerReadable, assertWorkGraphOwnerWritable, requireTrustedWorkGraphTenantSubject } from "./workgraphModel"
import type { DataModel, Doc, Id } from "./_generated/dataModel"
import { syncAttentionRecord } from "./workgraphAttention"

export const readForService = serviceQuery({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), query: v.any() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return readNotifications(ctx, tenant.organization_id as Id<"orgs">, tenant.owner_user_id, args.query)
  },
})
export const executeForService = serviceMutation({
  args: { organization_id: v.id("orgs"), owner_subject: v.string(), operation: v.any() },
  handler: async (ctx, args) => {
    const tenant = await requireTrustedWorkGraphTenantSubject(ctx, args.service_token, args.organization_id, args.owner_subject)
    return updateNotification(ctx, tenant.organization_id as Id<"orgs">, tenant.owner_user_id, args.operation)
  },
})

export async function readNotifications(ctx: GenericQueryCtx<DataModel>, organizationId: Id<"orgs">, ownerUserId: Id<"users">, input: unknown) {
  await assertWorkGraphOwnerReadable(ctx, organizationId, ownerUserId)
  const query = object(input)
  if (query.kind === "read") {
    const row = await owned(ctx, organizationId, ownerUserId, required(query.id))
    return row && await actionable(ctx, organizationId, ownerUserId, row.recap_id) ? dto(row) : null
  }
  if (query.kind !== "list") throw new Error("Unsupported notification query")
  const limit = Math.min(number(query.limit), 100)
  if (limit < 1) throw new Error("Expected positive notification limit")
  const state = query.state === undefined ? undefined : query.state === "unread" || query.state === "read" ? query.state : invalid()
  const cursor = query.after === undefined
    ? null
    : readNotificationCursor(query.after, String(organizationId), String(ownerUserId), state)
  const source = state
    ? ctx.db.query("workgraph_notifications").withIndex("by_tenant_state_created", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId).eq("state", state))
    : ctx.db.query("workgraph_notifications").withIndex("by_tenant_created", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
  const page = await source.order("desc").paginate({ cursor, numItems: limit })
  const notifications = (await Promise.all(page.page.map(async (row) =>
    await actionable(ctx, organizationId, ownerUserId, row.recap_id) ? dto(row) : null,
  ))).filter((notification) => notification !== null)
  return {
    notifications,
    hasMore: !page.isDone,
    ...(!page.isDone ? { nextCursor: createNotificationCursor(String(organizationId), String(ownerUserId), state, page.continueCursor) } : {}),
  }
}

export async function updateNotification(ctx: GenericMutationCtx<DataModel>, organizationId: Id<"orgs">, ownerUserId: Id<"users">, input: unknown) {
  await assertWorkGraphOwnerWritable(ctx, organizationId, ownerUserId)
  const operation = object(input)
  if (operation.type !== "mark_read") throw new Error("Unsupported notification operation")
  const row = await owned(ctx, organizationId, ownerUserId, required(operation.id))
  if (!row || !await actionable(ctx, organizationId, ownerUserId, row.recap_id) || row.state !== "unread" || row.row_version !== number(operation.expectedVersion)) return { state: "conflict" as const }
  const now = number(operation.now)
  const saved = { ...row, state: "read" as const, read_at: row.read_at ?? now, updated_at: now, row_version: row.row_version + 1 }
  await ctx.db.patch(row._id, saved)
  await syncAttentionRecord(ctx, "workgraph_notifications", saved)
  return { state: "updated" as const, notification: dto(saved) }
}

function owned(ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>, organizationId: Id<"orgs">, ownerUserId: Id<"users">, id: string) {
  return ctx.db.query("workgraph_notifications").withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("id"), id)).unique()
}
async function actionable(ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>, organizationId: Id<"orgs">, ownerUserId: Id<"users">, recapId: string) {
  const recap = await ctx.db.query("workgraph_recaps").withIndex("by_tenant", (builder) => builder.eq("organization_id", organizationId).eq("owner_user_id", ownerUserId))
    .filter((builder) => builder.eq(builder.field("id"), recapId)).unique()
  const generation = recap?.generation as { state?: string; method?: string; sessionId?: string } | undefined
  return generation?.state === "succeeded" && generation.method === "agent_session" && typeof generation.sessionId === "string"
}
function dto(row: Pick<Doc<"workgraph_notifications">, "id" | "owner_user_id" | "row_version" | "state" | "stream_id" | "recap_id" | "created_at" | "updated_at" | "read_at">) {
  return { id: row.id, ownerUserId: String(row.owner_user_id), version: row.row_version, kind: "actionable_recap" as const, state: row.state, streamId: row.stream_id, recapId: row.recap_id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.read_at === undefined ? {} : { readAt: row.read_at }) }
}
function object(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown> }
function required(value: unknown) { if (typeof value !== "string" || !value.trim()) throw new Error("Expected string"); return value }
function number(value: unknown) { const result = typeof value === "string" ? Number(value) : value; if (typeof result !== "number" || !Number.isInteger(result) || result < 0) throw new Error("Expected number"); return result }
function invalid(): never { throw new Error("Invalid notification state") }
function createNotificationCursor(organization: string, owner: string, state: "unread" | "read" | undefined, cursor: string) {
  return ["wgnc1", organization, owner, state ?? "all", cursor].map(encodeURIComponent).join(":")
}
function readNotificationCursor(value: unknown, organization: string, owner: string, state: "unread" | "read" | undefined) {
  if (typeof value !== "string") throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  const parts = decodeCursor(value)
  if (parts.length !== 5 || parts[0] !== "wgnc1" || !parts[4]) throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  if (parts[1] !== organization || parts[2] !== owner) throw new ConvexError({ code: "cursor_invalid", reason: "owner_mismatch" })
  if (parts[3] !== (state ?? "all")) throw new ConvexError({ code: "cursor_invalid", reason: "filter_mismatch" })
  return parts[4]
}
function decodeCursor(value: string) {
  try {
    return value.split(":").map((part) => decodeURIComponent(part))
  } catch {
    throw new ConvexError({ code: "cursor_invalid", reason: "invalid" })
  }
}
