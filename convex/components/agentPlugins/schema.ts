import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

const artifactPin = {
  artifact_digest: v.string(),
  source_id: v.string(),
  relative_path: v.string(),
  source_revision: v.string(),
}

export default defineSchema({
  revisions: defineTable({
    organization_id: v.string(),
    revision: v.number(),
    last_operation_id: v.optional(v.string()),
    last_operation_revision: v.optional(v.number()),
    updated_at: v.number(),
  }).index("by_organization", ["organization_id"]),

  artifact_pins: defineTable({
    organization_id: v.optional(v.string()),
    authority: v.union(v.literal("user"), v.literal("organization"), v.literal("claxedo")),
    owner_user_id: v.optional(v.string()),
    plugin_instance_id: v.string(),
    ...artifactPin,
    updated_at: v.number(),
  })
    .index("by_owner_plugin", ["organization_id", "authority", "owner_user_id", "plugin_instance_id"])
    .index("by_owner", ["organization_id", "authority", "owner_user_id"]),

  user_defaults: defineTable({
    organization_id: v.string(),
    owner_user_id: v.string(),
    plugin_instance_id: v.string(),
    harness_id: v.string(),
    enabled: v.boolean(),
    updated_at: v.number(),
  })
    .index("by_choice", ["organization_id", "owner_user_id", "plugin_instance_id", "harness_id"])
    .index("by_owner", ["organization_id", "owner_user_id"]),

  project_overrides: defineTable({
    organization_id: v.string(),
    owner_user_id: v.string(),
    project_id: v.string(),
    plugin_instance_id: v.string(),
    harness_id: v.string(),
    enabled: v.boolean(),
    updated_at: v.number(),
  })
    .index("by_choice", ["organization_id", "owner_user_id", "project_id", "plugin_instance_id", "harness_id"])
    .index("by_owner", ["organization_id", "owner_user_id"]),

  organization_defaults: defineTable({
    organization_id: v.string(),
    plugin_instance_id: v.string(),
    harness_id: v.string(),
    updated_at: v.number(),
  })
    .index("by_choice", ["organization_id", "plugin_instance_id", "harness_id"])
    .index("by_organization", ["organization_id"]),

  claxedo_defaults: defineTable({
    scope: v.literal("global"),
    plugin_instance_id: v.string(),
    harness_id: v.string(),
    updated_at: v.number(),
  })
    .index("by_choice", ["plugin_instance_id", "harness_id"])
    .index("by_scope", ["scope"]),
})
