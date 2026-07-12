import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

const orgRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"))
const workspaceRole = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"), v.literal("owner"))

export default defineSchema({
  users: defineTable({
    token_identifier: v.string(),
    clerk_subject: v.optional(v.string()),
    issuer: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image_url: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_token_identifier", ["token_identifier"])
    .index("by_clerk_subject", ["clerk_subject"]),

  orgs: defineTable({
    clerk_org_id: v.optional(v.string()),
    slug: v.optional(v.string()),
    name: v.string(),
    kind: v.optional(v.union(v.literal("personal"), v.literal("clerk"))),
    owner_user_id: v.optional(v.id("users")),
    deleted_at: v.optional(v.number()),
    clerk_updated_at: v.optional(v.number()),
    // ── B1 billing mirror (launch plan 2026-07-11-012 D5; ADR 014 §3) ──
    // Polar subscription state mirrored onto the org. ALL fields optional:
    // absent = free tier (fail-closed, invariant I-4), and optional keeps this
    // a pure EXPAND step (docs/tech-docs/convex-schema-evolution.md — no
    // migration required, old rows stay valid). SINGLE WRITER: only
    // convex/billing.ts (`applyPolarState`) may write these fields — enforced
    // grep-style by packages/claxedo-server/src/billing/billing-architecture.test.ts.
    plan: v.optional(v.union(v.literal("free"), v.literal("pro"))),
    polar_customer_id: v.optional(v.string()),
    polar_subscription_id: v.optional(v.string()),
    seats_licensed: v.optional(v.number()),
    subscription_status: v.optional(v.string()),
    current_period_end: v.optional(v.number()),
    /** Wall-clock of the last successful mirror write (reconciliation staleness clock). */
    billing_synced_at: v.optional(v.number()),
    /**
     * Source timestamp (Polar-side modified_at) of the last APPLIED state —
     * the ADR 014 §3 last-write-wins guard that makes webhook duplicates and
     * reordering harmless. Distinct from billing_synced_at on purpose.
     */
    polar_state_modified_at: v.optional(v.number()),
    /** Set by the crons.ts staleness sweep; cleared by the next applyPolarState. */
    billing_reconcile_flagged_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_clerk_org_id", ["clerk_org_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_polar_customer_id", ["polar_customer_id"]),

  org_memberships: defineTable({
    org_id: v.id("orgs"),
    user_id: v.id("users"),
    role: orgRole,
    clerk_updated_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_org_user", ["org_id", "user_id"]),

  workspaces: defineTable({
    workspace_id: v.string(),
    org_id: v.optional(v.id("orgs")),
    owner_user_id: v.id("users"),
    project_id: v.optional(v.string()),
    backing: v.union(v.literal("local-worktree"), v.literal("cloud-vm")),
    access: v.union(v.literal("local"), v.literal("cloud"), v.literal("user-hosted")),
    home_region: v.optional(v.string()),
    display_name: v.string(),
    repo_url: v.optional(v.string()),
    repo_name: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    // The worktree directory on the owner's machine that backs a user-hosted /
    // local workspace. Together with owner_user_id this is the workspace's
    // stable real-world identity; the app uses it to map a directory back to the
    // workspaceId (the routing key) so relay routing never depends on parsing
    // the directory string shape.
    remote_directory: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    deleted_at: v.optional(v.number()),
  })
    .index("by_owner", ["owner_user_id"])
    .index("by_org", ["org_id"])
    .index("by_workspace_id", ["workspace_id"]),

  projects: defineTable({
    project_id: v.optional(v.string()),
    org_id: v.optional(v.id("orgs")),
    owner_user_id: v.optional(v.id("users")),
    // Legacy staging/dev rows used camelCase project metadata before the
    // org/workspace schema landed. Keep these optional so code can deploy and
    // migrate/read around old rows without deleting dev data.
    externalId: v.optional(v.string()),
    organizationId: v.optional(v.string()),
    name: v.optional(v.string()),
    repoUrl: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    created_at: v.optional(v.number()),
    updated_at: v.optional(v.number()),
    deleted_at: v.optional(v.number()),
  })
    .index("by_project_id", ["project_id"])
    .index("by_org", ["org_id"])
    .index("by_owner", ["owner_user_id"]),

  project_memberships: defineTable({
    project_id: v.id("projects"),
    user_id: v.id("users"),
    role: workspaceRole,
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_project_user", ["project_id", "user_id"]),

  channel_identities: defineTable({
    channel: v.string(),
    external_user_id: v.string(),
    user_id: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
    revoked_at: v.optional(v.number()),
  })
    .index("by_channel_external_user", ["channel", "external_user_id"])
    .index("by_user", ["user_id"]),

  workspace_memberships: defineTable({
    workspace_id: v.id("workspaces"),
    user_id: v.id("users"),
    role: workspaceRole,
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_workspace_user", ["workspace_id", "user_id"]),

  workspace_share_grants: defineTable({
    workspace_id: v.id("workspaces"),
    granted_to_user_id: v.optional(v.id("users")),
    granted_to_org_id: v.optional(v.id("orgs")),
    role: v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin")),
    created_by_user_id: v.id("users"),
    created_at: v.number(),
    revoked_at: v.optional(v.number()),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_user", ["granted_to_user_id"])
    .index("by_org", ["granted_to_org_id"]),

  local_host_links: defineTable({
    workspace_id: v.id("workspaces"),
    owner_user_id: v.id("users"),
    host_id: v.string(),
    public_key: v.optional(v.string()),
    display_name: v.optional(v.string()),
    last_seen_at: v.number(),
    expires_at: v.number(),
    paused_at: v.optional(v.number()),
    // Pause provenance: a user pause must survive a kill-switch resume.
    paused_by: v.optional(v.union(v.literal("user"), v.literal("killswitch"))),
    paused_reason: v.optional(v.string()),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_host_id", ["host_id"])
    .index("by_expires_at", ["expires_at"]),

  host_attestation_challenges: defineTable({
    challenge_id: v.string(),
    // PUBLIC workspace id (not a doc reference): a challenge may be issued for
    // a never-registered workspace — the workspace doc is only created at
    // register time, after the host proves its key.
    workspace_id: v.string(),
    owner_user_id: v.id("users"),
    host_id: v.string(),
    nonce: v.string(),
    expires_at: v.number(),
    used_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_challenge_id", ["challenge_id"])
    .index("by_workspace", ["workspace_id"])
    .index("by_owner", ["owner_user_id"]),

  session_history: defineTable({
    session_id: v.string(),
    workspace_id: v.id("workspaces"),
    org_id: v.optional(v.id("orgs")),
    project_id: v.optional(v.id("projects")),
    created_by_user_id: v.optional(v.id("users")),
    title: v.optional(v.string()),
    directory_hint: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    deleted_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_workspace_updated", ["workspace_id", "updated_at"]),

  session_messages: defineTable({
    session_id: v.string(),
    workspace_id: v.id("workspaces"),
    message_id: v.string(),
    role: v.optional(v.string()),
    ordinal: v.number(),
    data: v.any(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_session_ordinal", ["session_id", "ordinal"])
    .index("by_message_id", ["message_id"]),

  runtime_access_tokens: defineTable({
    jti: v.string(),
    workspace_id: v.id("workspaces"),
    host_id: v.string(),
    minted_for_user_id: v.id("users"),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_jti", ["jti"])
    .index("by_workspace_user", ["workspace_id", "minted_for_user_id"]),

  runtime_leases: defineTable({
    workspace_id: v.string(),
    home_region: v.string(),
    driver: v.optional(v.string()),
    epoch: v.number(),
    status: v.union(
      v.literal("acquiring"),
      v.literal("ready"),
      v.literal("unavailable"),
      v.literal("stopped"),
      v.literal("destroyed"),
    ),
    retry_count: v.number(),
    sandbox_id: v.optional(v.string()),
    runtime_url: v.optional(v.string()),
    host_id: v.optional(v.string()),
    driver_resource_id: v.optional(v.string()),
    next_retry_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    last_heartbeat_at: v.optional(v.number()),
    last_activity_at: v.optional(v.number()),
    labels: v.optional(v.any()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_id", ["workspace_id"])
    .index("by_status", ["status"])
    .index("by_host_id", ["host_id"])
    .index("by_updated_at", ["updated_at"]),

  agent_extension_installs: defineTable({
    workspace_id: v.id("workspaces"),
    extension_id: v.string(),
    package_name: v.string(),
    desired: v.any(),
    lock: v.any(),
    enabled: v.boolean(),
    created_at: v.number(),
    updated_at: v.number(),
    deleted_at: v.optional(v.number()),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_workspace_extension", ["workspace_id", "extension_id"]),

  agent_extension_policy_overrides: defineTable({
    scope: v.union(v.literal("org"), v.literal("user"), v.literal("workspace")),
    extension_id: v.string(),
    org_id: v.optional(v.id("orgs")),
    user_id: v.optional(v.id("users")),
    workspace_id: v.optional(v.id("workspaces")),
    enabled: v.boolean(),
    reason: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    deleted_at: v.optional(v.number()),
  })
    .index("by_org", ["org_id"])
    .index("by_user", ["user_id"])
    .index("by_workspace", ["workspace_id"]),

  audit_events: defineTable({
    user_id: v.optional(v.id("users")),
    org_id: v.optional(v.id("orgs")),
    workspace_id: v.optional(v.id("workspaces")),
    project_id: v.optional(v.id("projects")),
    acting_for_user_id: v.optional(v.id("users")),
    host_id: v.optional(v.string()),
    action: v.string(),
    result: v.union(v.literal("allow"), v.literal("deny")),
    reason: v.optional(v.string()),
    metadata: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_workspace_created", ["workspace_id", "created_at"])
    .index("by_user_created", ["user_id", "created_at"]),
})
