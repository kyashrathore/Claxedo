import { v } from "convex/values"
import { mutation, query } from "./_generated/server"

const MAX_OWNER_ROWS = 2_000
const harness = v.union(
  v.literal("opencode"),
  v.literal("claude"),
  v.literal("codex"),
  v.literal("cursor"),
)
const artifact = v.object({
  digest: v.string(),
  sourceId: v.string(),
  relativePath: v.string(),
  sourceRevision: v.string(),
})

async function bounded<T>(promise: Promise<T[]>, label: string) {
  const rows = await promise
  if (rows.length > MAX_OWNER_ROWS) throw new Error(`${label} exceeds the Agent Plugins owner row limit`)
  return rows
}

async function revisionRow(ctx: any, organizationId: string) {
  return await ctx.db
    .query("revisions")
    .withIndex("by_organization", (q: any) => q.eq("organization_id", organizationId))
    .unique()
}

async function currentRevision(ctx: any, organizationId: string) {
  return (await revisionRow(ctx, organizationId))?.revision ?? 0
}

async function beginMutation(ctx: any, input: {
  organizationId: string
  expectedRevision: number
  operationId: string
}) {
  const row = await revisionRow(ctx, input.organizationId)
  if (row?.last_operation_id === input.operationId && row.last_operation_revision !== undefined) {
    return { replay: row.last_operation_revision as number, row }
  }
  const revision = row?.revision ?? 0
  if (revision !== input.expectedRevision) {
    throw new Error(`revision-conflict:${input.expectedRevision}:${revision}`)
  }
  return { revision, row }
}

async function finishMutation(ctx: any, input: {
  organizationId: string
  operationId: string
  currentRevision: number
  row?: { _id: unknown }
}) {
  const next = input.currentRevision + 1
  const value = {
    organization_id: input.organizationId,
    revision: next,
    last_operation_id: input.operationId,
    last_operation_revision: next,
    updated_at: Date.now(),
  }
  if (input.row) await ctx.db.patch(input.row._id, value)
  else await ctx.db.insert("revisions", value)
  return next
}

async function pin(ctx: any, input: {
  organizationId?: string
  authority: "user" | "organization" | "claxedo"
  ownerUserId?: string
  pluginInstanceId: string
}) {
  return await ctx.db
    .query("artifact_pins")
    .withIndex("by_owner_plugin", (q: any) => q
      .eq("organization_id", input.organizationId)
      .eq("authority", input.authority)
      .eq("owner_user_id", input.ownerUserId)
      .eq("plugin_instance_id", input.pluginInstanceId))
    .unique()
}

function publicPin(row: any) {
  return row ? {
    digest: row.artifact_digest,
    sourceId: row.source_id,
    relativePath: row.relative_path,
    sourceRevision: row.source_revision,
  } : undefined
}

async function writePin(ctx: any, input: {
  organizationId?: string
  authority: "user" | "organization" | "claxedo"
  ownerUserId?: string
  pluginInstanceId: string
  artifact: { digest: string; sourceId: string; relativePath: string; sourceRevision: string }
}) {
  const existing = await pin(ctx, input)
  const value = {
    organization_id: input.organizationId,
    authority: input.authority,
    owner_user_id: input.ownerUserId,
    plugin_instance_id: input.pluginInstanceId,
    artifact_digest: input.artifact.digest,
    source_id: input.artifact.sourceId,
    relative_path: input.artifact.relativePath,
    source_revision: input.artifact.sourceRevision,
    updated_at: Date.now(),
  }
  if (existing) await ctx.db.patch(existing._id, value)
  else await ctx.db.insert("artifact_pins", value)
}

async function writeChoice(ctx: any, input: {
  table: "user_defaults" | "project_overrides"
  organizationId: string
  ownerUserId: string
  projectId?: string
  pluginInstanceId: string
  harnessId: string
  choice?: boolean
}) {
  const existing = input.table === "user_defaults"
    ? await ctx.db.query(input.table).withIndex("by_choice", (q: any) => q
        .eq("organization_id", input.organizationId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("plugin_instance_id", input.pluginInstanceId)
        .eq("harness_id", input.harnessId)).unique()
    : await ctx.db.query(input.table).withIndex("by_choice", (q: any) => q
        .eq("organization_id", input.organizationId)
        .eq("owner_user_id", input.ownerUserId)
        .eq("project_id", input.projectId)
        .eq("plugin_instance_id", input.pluginInstanceId)
        .eq("harness_id", input.harnessId)).unique()
  if (input.choice === undefined) {
    if (existing) await ctx.db.delete(existing._id)
    return
  }
  const value = {
    organization_id: input.organizationId,
    owner_user_id: input.ownerUserId,
    ...(input.projectId ? { project_id: input.projectId } : {}),
    plugin_instance_id: input.pluginInstanceId,
    harness_id: input.harnessId,
    enabled: input.choice,
    updated_at: Date.now(),
  }
  if (existing) await ctx.db.patch(existing._id, value)
  else await ctx.db.insert(input.table, value)
}

export const revision = query({
  args: { organizationId: v.string() },
  handler: async (ctx, args) => await currentRevision(ctx, args.organizationId),
})

export const listKnown = query({
  args: { organizationId: v.string(), ownerUserId: v.string() },
  handler: async (ctx, args) => {
    const [userPins, organizationPins, claxedoPins, userDefaults, projectOverrides, organizationDefaults, claxedoDefaults] = await Promise.all([
      bounded(ctx.db.query("artifact_pins").withIndex("by_owner", (q: any) => q.eq("organization_id", args.organizationId).eq("authority", "user").eq("owner_user_id", args.ownerUserId)).take(MAX_OWNER_ROWS + 1), "user pins"),
      bounded(ctx.db.query("artifact_pins").withIndex("by_owner", (q: any) => q.eq("organization_id", args.organizationId).eq("authority", "organization").eq("owner_user_id", undefined)).take(MAX_OWNER_ROWS + 1), "organization pins"),
      bounded(ctx.db.query("artifact_pins").withIndex("by_owner", (q: any) => q.eq("organization_id", undefined).eq("authority", "claxedo").eq("owner_user_id", undefined)).take(MAX_OWNER_ROWS + 1), "Claxedo pins"),
      bounded(ctx.db.query("user_defaults").withIndex("by_owner", (q: any) => q.eq("organization_id", args.organizationId).eq("owner_user_id", args.ownerUserId)).take(MAX_OWNER_ROWS + 1), "user defaults"),
      bounded(ctx.db.query("project_overrides").withIndex("by_owner", (q: any) => q.eq("organization_id", args.organizationId).eq("owner_user_id", args.ownerUserId)).take(MAX_OWNER_ROWS + 1), "project overrides"),
      bounded(ctx.db.query("organization_defaults").withIndex("by_organization", (q: any) => q.eq("organization_id", args.organizationId)).take(MAX_OWNER_ROWS + 1), "organization defaults"),
      bounded(ctx.db.query("claxedo_defaults").withIndex("by_scope", (q: any) => q.eq("scope", "global")).take(MAX_OWNER_ROWS + 1), "Claxedo defaults"),
    ])
    const ids = new Set<string>()
    for (const rows of [userPins, organizationPins, claxedoPins, userDefaults, projectOverrides, organizationDefaults, claxedoDefaults]) {
      for (const row of rows) ids.add(row.plugin_instance_id)
    }
    return [...ids].sort().map((pluginInstanceId) => ({
      pluginInstanceId,
      pins: {
        user: publicPin(userPins.find((row) => row.plugin_instance_id === pluginInstanceId)),
        organization: publicPin(organizationPins.find((row) => row.plugin_instance_id === pluginInstanceId)),
        claxedo: publicPin(claxedoPins.find((row) => row.plugin_instance_id === pluginInstanceId)),
      },
    }))
  },
})

export const read = query({
  args: {
    organizationId: v.string(),
    ownerUserId: v.string(),
    projectId: v.optional(v.string()),
    pluginInstanceId: v.string(),
    harnessId: harness,
  },
  handler: async (ctx, args) => {
    const [projectOverride, userDefault, organizationDefault, claxedoDefault, userPin, organizationPin, claxedoPin] = await Promise.all([
      args.projectId ? ctx.db.query("project_overrides").withIndex("by_choice", (q: any) => q
        .eq("organization_id", args.organizationId).eq("owner_user_id", args.ownerUserId)
        .eq("project_id", args.projectId).eq("plugin_instance_id", args.pluginInstanceId)
        .eq("harness_id", args.harnessId)).unique() : undefined,
      ctx.db.query("user_defaults").withIndex("by_choice", (q: any) => q
        .eq("organization_id", args.organizationId).eq("owner_user_id", args.ownerUserId)
        .eq("plugin_instance_id", args.pluginInstanceId).eq("harness_id", args.harnessId)).unique(),
      ctx.db.query("organization_defaults").withIndex("by_choice", (q: any) => q
        .eq("organization_id", args.organizationId).eq("plugin_instance_id", args.pluginInstanceId)
        .eq("harness_id", args.harnessId)).unique(),
      ctx.db.query("claxedo_defaults").withIndex("by_choice", (q: any) => q
        .eq("plugin_instance_id", args.pluginInstanceId).eq("harness_id", args.harnessId)).unique(),
      pin(ctx, { organizationId: args.organizationId, authority: "user", ownerUserId: args.ownerUserId, pluginInstanceId: args.pluginInstanceId }),
      pin(ctx, { organizationId: args.organizationId, authority: "organization", pluginInstanceId: args.pluginInstanceId }),
      pin(ctx, { authority: "claxedo", pluginInstanceId: args.pluginInstanceId }),
    ])
    return {
      revision: await currentRevision(ctx, args.organizationId),
      pluginInstanceId: args.pluginInstanceId,
      harnessId: args.harnessId,
      projectId: args.projectId,
      projectOverride: projectOverride?.enabled,
      userDefault: userDefault?.enabled,
      organizationDefault: organizationDefault ? true : undefined,
      claxedoDefault: claxedoDefault ? true : undefined,
      pins: {
        user: userPin?.artifact_digest,
        organization: organizationPin?.artifact_digest,
        claxedo: claxedoPin?.artifact_digest,
      },
    }
  },
})

export const mutateUser = mutation({
  args: {
    organizationId: v.string(), ownerUserId: v.string(), pluginInstanceId: v.string(),
    harnessIds: v.array(harness), choice: v.optional(v.boolean()),
    target: v.union(
      v.object({ scope: v.literal("all-projects") }),
      v.object({ scope: v.literal("projects"), projectIds: v.array(v.string()) }),
    ),
    artifact: v.optional(artifact), expectedRevision: v.number(), operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const started = await beginMutation(ctx, args)
    if ("replay" in started) return started.replay
    if (args.artifact) await writePin(ctx, {
      organizationId: args.organizationId, authority: "user", ownerUserId: args.ownerUserId,
      pluginInstanceId: args.pluginInstanceId, artifact: args.artifact,
    })
    if (args.choice === true && !await pin(ctx, {
      organizationId: args.organizationId, authority: "user", ownerUserId: args.ownerUserId,
      pluginInstanceId: args.pluginInstanceId,
    })) throw new Error("artifact-unavailable:user")
    for (const harnessId of [...new Set(args.harnessIds)]) {
      if (args.target.scope === "all-projects") {
        await writeChoice(ctx, {
          table: "user_defaults", organizationId: args.organizationId, ownerUserId: args.ownerUserId,
          pluginInstanceId: args.pluginInstanceId, harnessId, choice: args.choice,
        })
      } else {
        for (const projectId of [...new Set(args.target.projectIds)]) await writeChoice(ctx, {
          table: "project_overrides", organizationId: args.organizationId, ownerUserId: args.ownerUserId,
          projectId, pluginInstanceId: args.pluginInstanceId, harnessId, choice: args.choice,
        })
      }
    }
    return await finishMutation(ctx, {
      organizationId: args.organizationId, operationId: args.operationId,
      currentRevision: started.revision, row: started.row,
    })
  },
})

export const mutateOrganizationDefault = mutation({
  args: {
    organizationId: v.string(), pluginInstanceId: v.string(), harnessIds: v.array(harness),
    choice: v.optional(v.literal(true)), artifact: v.optional(artifact),
    expectedRevision: v.number(), operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const started = await beginMutation(ctx, args)
    if ("replay" in started) return started.replay
    if (args.artifact) await writePin(ctx, {
      organizationId: args.organizationId, authority: "organization",
      pluginInstanceId: args.pluginInstanceId, artifact: args.artifact,
    })
    if (args.choice === true && !await pin(ctx, {
      organizationId: args.organizationId, authority: "organization", pluginInstanceId: args.pluginInstanceId,
    })) throw new Error("artifact-unavailable:organization")
    for (const harnessId of [...new Set(args.harnessIds)]) {
      const existing = await ctx.db.query("organization_defaults").withIndex("by_choice", (q: any) => q
        .eq("organization_id", args.organizationId).eq("plugin_instance_id", args.pluginInstanceId)
        .eq("harness_id", harnessId)).unique()
      if (args.choice === undefined) {
        if (existing) await ctx.db.delete(existing._id)
      } else if (!existing) {
        await ctx.db.insert("organization_defaults", {
          organization_id: args.organizationId, plugin_instance_id: args.pluginInstanceId,
          harness_id: harnessId, updated_at: Date.now(),
        })
      }
    }
    return await finishMutation(ctx, {
      organizationId: args.organizationId, operationId: args.operationId,
      currentRevision: started.revision, row: started.row,
    })
  },
})

export const updatePin = mutation({
  args: {
    organizationId: v.string(), ownerUserId: v.optional(v.string()),
    authority: v.union(v.literal("user"), v.literal("organization")),
    pluginInstanceId: v.string(), artifact,
    expectedRevision: v.number(), operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const started = await beginMutation(ctx, args)
    if ("replay" in started) return started.replay
    const existing = await pin(ctx, {
      organizationId: args.organizationId, authority: args.authority,
      ownerUserId: args.authority === "user" ? args.ownerUserId : undefined,
      pluginInstanceId: args.pluginInstanceId,
    })
    if (!existing) throw new Error(`artifact-unavailable:${args.authority}`)
    await writePin(ctx, {
      organizationId: args.organizationId, authority: args.authority,
      ownerUserId: args.authority === "user" ? args.ownerUserId : undefined,
      pluginInstanceId: args.pluginInstanceId, artifact: args.artifact,
    })
    return await finishMutation(ctx, {
      organizationId: args.organizationId, operationId: args.operationId,
      currentRevision: started.revision, row: started.row,
    })
  },
})
