import { mutationGeneric, queryGeneric, type GenericDatabaseReader, type GenericDatabaseWriter } from "convex/server"
import { v, type GenericId } from "convex/values"
import { authorizeWorkspace, workspaceByPublicId } from "./model"

const workspaceId = { workspace_id: v.string() }
type Db = GenericDatabaseReader<any> | GenericDatabaseWriter<any>
type AgentExtensionInstall = {
  _id: GenericId<"agent_extension_installs">
  extension_id: string
  desired: Record<string, unknown>
  lock: unknown
  enabled: boolean
  updated_at: number
  deleted_at?: number
}

function object(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function sourceKey(input: unknown) {
  const source = object(input)
  if (!source) return
  return JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))
}

function serviceToken() {
  const value = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN?.trim()
  return value ? value : undefined
}

async function workspaceAgentExtensions(ctx: { db: Db }, workspaceId: string) {
  const workspace = await workspaceByPublicId(ctx.db, workspaceId)
  if (!workspace) return []
  return ((await ctx.db
    .query("agent_extension_installs")
    .withIndex("by_workspace", (q) => q.eq("workspace_id", workspace._id))
    .collect()) as AgentExtensionInstall[])
    .filter((item) => !item.deleted_at)
    .sort((a, b) => String(a.extension_id).localeCompare(String(b.extension_id)))
    .map((item) => ({
      desired: item.desired,
      lock: item.lock,
      enabled: item.enabled,
      updated_at: item.updated_at,
    }))
}

async function workspaceExtensionInstall(ctx: { db: Db }, workspaceId: unknown, extensionId: string) {
  return ((await ctx.db
    .query("agent_extension_installs")
    .withIndex("by_workspace_extension", (q) => q.eq("workspace_id", workspaceId))
    .collect()) as AgentExtensionInstall[])
    .find((item) => item.extension_id === extensionId)
}

export const list = queryGeneric({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "read")) return []
    return workspaceAgentExtensions(ctx, args.workspace_id)
  },
})

export const listForRuntime = queryGeneric({
  args: {
    ...workspaceId,
    service_token: v.string(),
  },
  handler: async (ctx, args) => {
    const expected = serviceToken()
    if (!expected || args.service_token !== expected) throw new Error("Unauthenticated")
    return workspaceAgentExtensions(ctx, args.workspace_id)
  },
})

export const authorizeAdmin = queryGeneric({
  args: workspaceId,
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    return { allowed: true }
  },
})

export const upsert = mutationGeneric({
  args: {
    workspace_id: v.string(),
    extension_id: v.string(),
    package_name: v.string(),
    desired: v.any(),
    lock: v.any(),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const now = Date.now()
    const existing = await workspaceExtensionInstall(ctx, workspace._id, args.extension_id)
    const patch = {
      package_name: args.package_name,
      desired: args.desired,
      lock: args.lock,
      enabled: !!args.desired.enabled,
      updated_at: now,
      deleted_at: undefined,
    }
    if (existing) {
      const existingSource = sourceKey(existing.desired.source)
      const requestedSource = sourceKey(object(args.desired)?.source)
      if (existingSource && requestedSource && existingSource !== requestedSource) {
        throw new Error("Agent Extension is already installed from a different source")
      }
      await ctx.db.patch(existing._id, patch)
      return { extension_id: args.extension_id }
    }
    await ctx.db.insert("agent_extension_installs", {
      workspace_id: workspace._id,
      extension_id: args.extension_id,
      created_at: now,
      ...patch,
    })
    return { extension_id: args.extension_id }
  },
})

export const setEnabled = mutationGeneric({
  args: {
    workspace_id: v.string(),
    extension_id: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const existing = await workspaceExtensionInstall(ctx, workspace._id, args.extension_id)
    if (!existing || existing.deleted_at) throw new Error("Agent Extension not found")
    await ctx.db.patch(existing._id, {
      enabled: args.enabled,
      desired: {
        ...existing.desired,
        enabled: args.enabled,
        updated_at: Date.now(),
      },
      updated_at: Date.now(),
    })
    return { extension_id: args.extension_id, enabled: args.enabled }
  },
})

export const remove = mutationGeneric({
  args: {
    workspace_id: v.string(),
    extension_id: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await workspaceByPublicId(ctx.db, args.workspace_id)
    if (!workspace || !await authorizeWorkspace(ctx, workspace, "admin")) throw new Error("Workspace not found")
    const existing = await workspaceExtensionInstall(ctx, workspace._id, args.extension_id)
    if (existing && !existing.deleted_at) {
      await ctx.db.patch(existing._id, {
        deleted_at: Date.now(),
        updated_at: Date.now(),
      })
    }
    return { ok: true }
  },
})

export { remove as delete }
