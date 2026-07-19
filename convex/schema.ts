import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

const orgRole = v.union(v.literal("owner"), v.literal("admin"), v.literal("member"))
const workspaceRole = v.union(v.literal("viewer"), v.literal("editor"), v.literal("admin"), v.literal("owner"))
const workGraphOwner = {
  organization_id: v.id("orgs"),
  owner_user_id: v.id("users"),
}
const workGraphVersion = { row_version: v.number(), schema_version: v.number() }
const workGraphCreated = { schema_version: v.number(), created_at: v.number() }
const workGraphMutable = { ...workGraphVersion, created_at: v.number(), updated_at: v.number() }
const workSourceRevisionRef = v.object({
  work_source_id: v.string(),
  revision_id: v.string(),
  content_hash: v.string(),
})

export default defineSchema({
  users: defineTable({
    token_identifier: v.string(),
    clerk_subject: v.optional(v.string()),
    issuer: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image_url: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    // Compatibility envelope for rows written before the hosted remote-access
    // switch moved out of the user document.
    remote_access_enabled: v.optional(v.boolean()),
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
    /**
     * F11 (adversarial review): wall-clock when the org FIRST transitioned into
     * `past_due`. Stamped once on the entry transition and PRESERVED across
     * subsequent dunning webhooks (which would otherwise re-anchor the grace
     * window every retry). Entitlement's grace window measures from here, not
     * from billing_synced_at / the current write time. Cleared when the org
     * leaves past_due (recovers or terminates). Additive/optional → pure EXPAND.
     */
    past_due_since: v.optional(v.number()),
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
    second_device_open_at: v.optional(v.number()),
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
    workspace_id: v.optional(v.id("workspaces")),
    workspace_public_id: v.optional(v.string()),
    host_id: v.string(),
    minted_for_user_id: v.optional(v.id("users")),
    minted_for_subject: v.optional(v.string()),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_jti", ["jti"])
    .index("by_workspace_user", ["workspace_id", "minted_for_user_id"]),

  runtime_leases: defineTable({
    workspace_id: v.string(),
    home_region: v.string(),
    // Expand phase for the provider -> driver field migration. Keep these
    // optional until every deployment has recorded the migration completion.
    provider: v.optional(v.string()),
    provider_runtime_id: v.optional(v.string()),
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

  // WorkGraph is personal-first. Every personal document carries its tenant
  // tuple and every runtime index starts with organization_id + owner_user_id.
  workgraphs: defineTable({
    ...workGraphOwner,
    id: v.string(),
    defaults: v.any(),
    activity_granularity: v.optional(v.union(v.literal("milestones"), v.literal("progress"), v.literal("detailed"))),
    provenance: v.optional(v.any()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"]),

  work_sources: defineTable({
    ...workGraphOwner,
    id: v.string(),
    workgraph_id: v.string(),
    title: v.string(),
    source_kind: v.string(),
    metadata: v.any(),
    latest_revision_id: v.optional(v.string()),
    latest_revision_number: v.number(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_workgraph_updated", ["organization_id", "owner_user_id", "workgraph_id", "updated_at"]),

  work_source_revisions: defineTable({
    ...workGraphOwner,
    id: v.string(),
    work_source_id: v.string(),
    revision_number: v.number(),
    content: v.string(),
    content_hash: v.string(),
    origin: v.any(),
    created_by: v.any(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_source_revision", ["organization_id", "owner_user_id", "work_source_id", "revision_number"]),

  workgraph_source_views: defineTable({
    ...workGraphOwner,
    id: v.string(),
    workgraph_id: v.string(),
    team_connection_id: v.string(),
    provider: v.string(),
    provider_user_id: v.string(),
    filters: v.any(),
    target: v.optional(v.any()),
    refresh_policy: v.optional(v.any()),
    sync_policy: v.string(),
    status: v.string(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_provider_status", ["organization_id", "owner_user_id", "provider", "status"])
    .index("by_tenant_connection", ["organization_id", "owner_user_id", "team_connection_id"])
    .index("by_tenant_connection_provider_status", [
      "organization_id",
      "owner_user_id",
      "team_connection_id",
      "provider",
      "status",
    ]),

  workgraph_webhook_deliveries: defineTable({
    connection_id: v.string(),
    provider: v.string(),
    delivery_id: v.string(),
    event_type: v.string(),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
    claimed_by: v.optional(v.string()),
    claim_expires_at: v.optional(v.number()),
    attempt_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_delivery", ["connection_id", "provider", "delivery_id"]),

  workgraph_intake_candidates: defineTable({
    ...workGraphOwner,
    id: v.string(),
    workgraph_id: v.string(),
    source_view_id: v.optional(v.string()),
    candidate_kind: v.union(v.literal("external_issue"), v.literal("session")),
    title: v.string(),
    body: v.string(),
    normalized: v.any(),
    attention_projection: v.optional(v.union(v.literal("none"), v.literal("external_issue"), v.literal("session"))),
    status: v.union(v.literal("unorganized"), v.literal("staged"), v.literal("confirmed"), v.literal("dismissed")),
    observed_revision: v.optional(v.string()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_status_updated_id", ["organization_id", "owner_user_id", "status", "updated_at", "id"])
    .index("by_tenant_status_source_updated_id", ["organization_id", "owner_user_id", "status", "source_view_id", "updated_at", "id"]),

  workgraph_external_identities: defineTable({
    ...workGraphOwner,
    id: v.string(),
    intake_candidate_id: v.optional(v.string()),
    provider: v.string(),
    team_connection_id: v.string(),
    external_id: v.string(),
    external_key: v.optional(v.string()),
    external_url: v.optional(v.string()),
    observed_revision: v.optional(v.string()),
    metadata: v.any(),
    ...workGraphCreated,
    updated_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_external", ["organization_id", "owner_user_id", "provider", "team_connection_id", "external_id"]),

  workgraph_streams: defineTable({
    ...workGraphOwner,
    id: v.string(),
    workgraph_id: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    charter: v.optional(v.object({ text: v.string(), hash: v.string() })),
    master_status: v.optional(v.object({
      state: v.string(),
      /** Typed escalation discriminant ('public_pr_confirmation' | 'failure_halt') —
       *  surfaces and resolvers dispatch on this, never on message prose. */
      escalation: v.optional(v.string()),
      sessionId: v.optional(v.string()),
      turnId: v.optional(v.string()),
      historyAfter: v.optional(v.number()),
      admissionConfirmed: v.optional(v.boolean()),
      failureCount: v.optional(v.number()),
      message: v.string(),
      receiptRefs: v.array(v.string()),
      charterHash: v.optional(v.string()),
      updatedAt: v.number(),
    })),
    notes_source: v.optional(workSourceRevisionRef),
    public_pr_confirmed_at: v.optional(v.number()),
    lifecycle_state: v.string(),
    visibility: v.string(),
    pinned: v.boolean(),
    execution_defaults: v.any(),
    activity_granularity: v.optional(v.union(v.literal("milestones"), v.literal("progress"), v.literal("detailed"))),
    activity: v.any(),
    deletion: v.optional(v.any()),
    closure: v.optional(v.any()),
    replacement_reset: v.optional(v.any()),
    envelope: v.optional(v.any()),
    stream_kind: v.optional(v.string()),
    base_repository: v.optional(v.string()),
    base_revision: v.optional(v.string()),
    envelope_intent: v.optional(v.any()),
    last_activity_at: v.optional(v.number()),
    closed_at: v.optional(v.number()),
    durable_effect_count: v.number(),
    source_revision_refs: v.array(workSourceRevisionRef),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_updated", ["organization_id", "owner_user_id", "updated_at"])
    .index("by_tenant_pinned_updated", ["organization_id", "owner_user_id", "pinned", "updated_at"])
    .index("by_tenant_workgraph_lifecycle", [
      "organization_id",
      "owner_user_id",
      "workgraph_id",
      "lifecycle_state",
      "updated_at",
    ]),

  workgraph_outcomes: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    state: v.string(),
    success_criteria: v.array(v.string()),
    evidence_ids: v.array(v.string()),
    execution_defaults: v.optional(v.any()),
    source_revision_refs: v.array(workSourceRevisionRef),
    closed_at: v.optional(v.number()),
    closed_by: v.optional(v.any()),
    close_reason: v.optional(v.string()),
    reopened_at: v.optional(v.number()),
    reopen_reason: v.optional(v.string()),
    ready_to_close_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_updated", ["organization_id", "owner_user_id", "updated_at"])
    .index("by_tenant_stream_state", ["organization_id", "owner_user_id", "stream_id", "state", "updated_at"]),

  workgraph_work_items: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    outcome_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    state: v.string(),
    priority: v.number(),
    source_revision_refs: v.array(workSourceRevisionRef),
    completion_contract: v.any(),
    evidence_ids: v.array(v.string()),
    execution_defaults: v.optional(v.any()),
    // Approval-gate origin provenance (plan 2026-07-18-003 §8.1). The actor that
    // materialized the task decides its born state; these fields carry the audit
    // trail so the UI/archive can attribute agent-created work. Optional and
    // backfill-free — legacy rows read as unknown origin.
    created_by_actor_type: v.optional(v.string()),
    created_by_actor_id: v.optional(v.string()),
    origin_attempt_id: v.optional(v.string()),
    abandoned_at: v.optional(v.number()),
    abandon_reason: v.optional(v.string()),
    completed_at: v.optional(v.number()),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_updated", ["organization_id", "owner_user_id", "updated_at"])
    .index("by_tenant_stream_state", ["organization_id", "owner_user_id", "stream_id", "state", "updated_at"])
    .index("by_tenant_outcome_state", ["organization_id", "owner_user_id", "outcome_id", "state", "priority"]),

  workgraph_work_item_dependencies: defineTable({
    ...workGraphOwner,
    id: v.string(),
    work_item_id: v.string(),
    stream_id: v.optional(v.string()),
    depends_on_work_item_id: v.string(),
    dependency_kind: v.string(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_item", ["organization_id", "owner_user_id", "work_item_id"])
    .index("by_tenant_dependency", ["organization_id", "owner_user_id", "depends_on_work_item_id"]),

  workgraph_attempts: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    work_item_id: v.string(),
    attempt_number: v.number(),
    state: v.string(),
    execution_kind: v.optional(v.union(v.literal("managed"), v.literal("attached"))),
    resolved_execution: v.any(),
    admitted_at: v.number(),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
    result: v.optional(v.any()),
    attention_reason: v.optional(v.string()),
    envelope_id: v.optional(v.string()),
    child_workspace_id: v.optional(v.string()),
    session_id: v.optional(v.string()),
    completion_retry: v.optional(v.object({ terminal_seq: v.number(), requested_at: v.number() })),
    cancellation: v.optional(v.any()),
    source_revision_refs: v.array(workSourceRevisionRef),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_item_attempt", ["organization_id", "owner_user_id", "work_item_id", "attempt_number"])
    .index("by_tenant_item_updated_id", ["organization_id", "owner_user_id", "work_item_id", "updated_at", "id"])
    .index("by_tenant_stream_state", ["organization_id", "owner_user_id", "stream_id", "state", "updated_at"])
    .index("by_tenant_state_updated", ["organization_id", "owner_user_id", "state", "updated_at"]),

  workgraph_session_bindings: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    session_id: v.string(),
    project_id: v.string(),
    current_work_item_id: v.optional(v.string()),
    current_attempt_id: v.optional(v.string()),
    state: v.union(v.literal("active"), v.literal("released")),
    bound_at: v.number(),
    released_at: v.optional(v.number()),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_session", ["organization_id", "owner_user_id", "session_id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"]),

  workgraph_agent_checkpoints: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    work_item_id: v.string(),
    attempt_id: v.string(),
    session_binding_id: v.string(),
    level: v.union(v.literal("milestone"), v.literal("progress"), v.literal("detail")),
    summary: v.string(),
    evidence_ids: v.array(v.string()),
    occurred_at: v.number(),
    operation_id: v.string(),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_operation", ["organization_id", "owner_user_id", "operation_id"])
    .index("by_tenant_item_occurred_id", ["organization_id", "owner_user_id", "work_item_id", "occurred_at", "id"])
    .index("by_tenant_binding", ["organization_id", "owner_user_id", "session_binding_id"]),

  // Secret-free references used to authorize one Attempt's callback-scoped
  // Connection operations. Provider credentials remain in Connections.
  workgraph_connection_metadata: defineTable({
    organization_id: v.id("orgs"),
    connection_id: v.string(),
    integration_id: v.union(v.literal("github"), v.literal("linear"), v.literal("jira")),
    capabilities: v.array(v.string()),
    status: v.union(v.literal("connected"), v.literal("degraded"), v.literal("broken")),
    account_label: v.optional(v.string()),
    fields: v.optional(v.record(v.string(), v.string())),
    token_type: v.optional(v.union(v.literal("bearer"), v.literal("basic"))),
    ...workGraphMutable,
  })
    .index("by_connection", ["connection_id"])
    .index("by_organization_connection", ["organization_id", "connection_id"]),

  workgraph_attempt_connection_bindings: defineTable({
    ...workGraphOwner,
    attempt_id: v.string(),
    session_id: v.string(),
    workspace_id: v.string(),
    connection_ids: v.array(v.string()),
    tools: v.array(v.string()),
    revoked_at: v.optional(v.number()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_attempt", ["organization_id", "owner_user_id", "attempt_id"])
    .index("by_tenant_session_workspace", ["organization_id", "owner_user_id", "session_id", "workspace_id"]),

  workgraph_leases: defineTable({
    ...workGraphOwner,
    id: v.string(),
    resource_type: v.string(),
    resource_id: v.string(),
    stream_id: v.optional(v.string()),
    holder_id: v.string(),
    epoch: v.number(),
    expires_at: v.number(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_resource", ["organization_id", "owner_user_id", "resource_type", "resource_id"])
    .index("by_tenant_expiry", ["organization_id", "owner_user_id", "expires_at"]),

  workgraph_decisions: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    state: v.string(),
    question: v.string(),
    options: v.array(v.any()),
    recommendation_option_id: v.optional(v.string()),
    rationale: v.optional(v.string()),
    answer: v.optional(v.any()),
    dismissed_at: v.optional(v.number()),
    dismiss_reason: v.optional(v.string()),
    source_revision_refs: v.array(workSourceRevisionRef),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_stream_state", ["organization_id", "owner_user_id", "stream_id", "state", "updated_at"]),

  workgraph_decision_work_items: defineTable({
    ...workGraphOwner,
    id: v.string(),
    decision_id: v.string(),
    stream_id: v.optional(v.string()),
    work_item_id: v.string(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_decision", ["organization_id", "owner_user_id", "decision_id"])
    .index("by_tenant_item", ["organization_id", "owner_user_id", "work_item_id"]),

  workgraph_evidence: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    subject_type: v.string(),
    subject_id: v.string(),
    evidence_kind: v.string(),
    summary: v.string(),
    reference: v.any(),
    provenance: v.any(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_subject", ["organization_id", "owner_user_id", "subject_type", "subject_id", "created_at"])
    .index("by_tenant_subject_created_id", [
      "organization_id",
      "owner_user_id",
      "subject_type",
      "subject_id",
      "created_at",
      "id",
    ]),

  workgraph_durable_effect_receipts: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    attempt_id: v.optional(v.string()),
    effect_kind: v.string(),
    idempotency_key: v.string(),
    external_reference: v.any(),
    provenance: v.any(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_idempotency", ["organization_id", "owner_user_id", "idempotency_key"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_stream_created", ["organization_id", "owner_user_id", "stream_id", "created_at"])
    .index("by_tenant_stream_created_id", ["organization_id", "owner_user_id", "stream_id", "created_at", "id"]),

  workgraph_admission_proposals: defineTable({
    ...workGraphOwner,
    id: v.string(),
    workgraph_id: v.string(),
    state: v.string(),
    source: v.optional(workSourceRevisionRef),
    previous_source: v.optional(workSourceRevisionRef),
    intake_candidate_id: v.optional(v.string()),
    proposal_kind: v.string(),
    generation: v.optional(v.any()),
    execution_defaults: v.optional(v.any()),
    diff_summary: v.optional(v.string()),
    suggested_placement: v.optional(v.any()),
    placement_matches: v.optional(v.array(v.any())),
    proposed_outcomes: v.optional(v.array(v.any())),
    proposed_work_items: v.optional(v.array(v.any())),
    duplicate_matches: v.optional(v.array(v.any())),
    planning_evidence: v.optional(v.any()),
    disposition: v.optional(v.any()),
    confirmed_change_cursor: v.optional(v.number()),
    provenance: v.any(),
    ...workGraphMutable,
    confirmed_at: v.optional(v.number()),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_state_updated", ["organization_id", "owner_user_id", "state", "updated_at"]),

  // Owner-scoped materialized Attention membership. Canonical records remain
  // the source of item detail; this table only owns bounded ordering and exact
  // membership, so Attention never scans every owner record at read time.
  workgraph_attention_entries: defineTable({
    ...workGraphOwner,
    kind: v.string(),
    id: v.string(),
    source_type: v.string(),
    position_key: v.string(),
    updated_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_kind_id", ["organization_id", "owner_user_id", "kind", "id"])
    .index("by_tenant_position", ["organization_id", "owner_user_id", "position_key"]),

  workgraph_attention_summaries: defineTable({
    ...workGraphOwner,
    total: v.number(),
    visible_total: v.optional(v.number()),
    external_issue_count: v.number(),
    session_count: v.number(),
    read_through_at: v.optional(v.number()),
    cleared_through_at: v.optional(v.number()),
    projection_version: v.union(v.literal(1), v.literal(2)),
    updated_at: v.number(),
  }).index("by_tenant", ["organization_id", "owner_user_id"]),

  workgraph_operation_results: defineTable({
    ...workGraphOwner,
    id: v.string(),
    command_type: v.string(),
    request_hash: v.string(),
    result_status: v.number(),
    result: v.any(),
    change_cursor: v.optional(v.number()),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"]),

  workgraph_stream_sequences: defineTable({
    ...workGraphOwner,
    stream_id: v.string(),
    next_sequence: v.number(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"]),

  workgraph_change_cursors: defineTable({
    ...workGraphOwner,
    next_cursor: v.number(),
    ...workGraphMutable,
  }).index("by_tenant", ["organization_id", "owner_user_id"]),

  workgraph_events: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.optional(v.string()),
    sequence: v.number(),
    operation_id: v.string(),
    request_id: v.optional(v.string()),
    event_type: v.string(),
    actor_type: v.string(),
    actor_id: v.string(),
    payload: v.any(),
    correlation_id: v.optional(v.string()),
    causation_id: v.optional(v.string()),
    occurred_at: v.number(),
    schema_version: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream_sequence", ["organization_id", "owner_user_id", "stream_id", "sequence"])
    .index("by_tenant_stream_occurred_id", ["organization_id", "owner_user_id", "stream_id", "occurred_at", "id"])
    .index("by_tenant_operation", ["organization_id", "owner_user_id", "operation_id"]),

  workgraph_changes: defineTable({
    ...workGraphOwner,
    id: v.string(),
    cursor: v.number(),
    stream_id: v.optional(v.string()),
    operation_id: v.string(),
    event_id: v.optional(v.string()),
    resource_type: v.string(),
    resource_id: v.string(),
    change_type: v.string(),
    payload: v.any(),
    snapshot_relevant: v.optional(v.boolean()),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_cursor", ["organization_id", "owner_user_id", "cursor"])
    .index("by_tenant_resource_cursor", ["organization_id", "owner_user_id", "resource_type", "resource_id", "cursor"])
    .index("by_tenant_resource_created_id", ["organization_id", "owner_user_id", "resource_type", "resource_id", "created_at", "id"])
    .index("by_tenant_snapshot_cursor", ["organization_id", "owner_user_id", "snapshot_relevant", "cursor"])
    .index("by_tenant_stream_cursor", ["organization_id", "owner_user_id", "stream_id", "cursor"]),

  workgraph_record_source_revisions: defineTable({
    ...workGraphOwner,
    id: v.string(),
    record_type: v.string(),
    record_id: v.string(),
    work_source_id: v.string(),
    source_revision_id: v.string(),
    ordinal: v.number(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_record", ["organization_id", "owner_user_id", "record_type", "record_id", "ordinal"]),

  workgraph_runtime_effects: defineTable({
    ...workGraphOwner,
    id: v.string(),
    effect_kind: v.string(),
    resource_type: v.string(),
    resource_id: v.string(),
    idempotency_key: v.string(),
    payload: v.any(),
    state: v.literal("completed"),
    attempt_count: v.number(),
    completed_at: v.number(),
    ...workGraphCreated,
    updated_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_idempotency", ["organization_id", "owner_user_id", "idempotency_key"]),

  workgraph_archive_restores: defineTable({
    ...workGraphOwner,
    operation_id: v.string(),
    archive_hash: v.string(),
    result: v.any(),
    schema_version: v.literal(1),
    created_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_operation", ["organization_id", "owner_user_id", "operation_id"]),

  // This receipt deliberately has no owner_user_id. Permanent deletion removes
  // every owner-scoped row, while this hashed receipt preserves exact replay.
  workgraph_owner_deletion_receipts: defineTable({
    owner_subject_hash: v.string(),
    operation_hash: v.string(),
    state: v.union(v.literal("cleaning"), v.literal("deleting"), v.literal("completed")),
    target_snapshot_hash: v.string(),
    targets: v.optional(
      v.array(
        v.object({
          streamId: v.string(),
          envelopeId: v.string(),
          childIsolationIds: v.array(v.string()),
        }),
      ),
    ),
    result: v.optional(
      v.object({
        deleted: v.literal(true),
        recordCount: v.number(),
        workspaceCount: v.number(),
        completedAt: v.number(),
      }),
    ),
    deleted_record_count: v.optional(v.number()),
    lease_expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_owner_state", ["owner_subject_hash", "state"])
    .index("by_owner_operation", ["owner_subject_hash", "operation_hash"]),

  // This transient row is the transaction-visible write fence while external
  // workspace cleanup runs. Finalize or release removes it before the durable,
  // hash-only receipt becomes the sole deletion record.
  workgraph_owner_deletion_barriers: defineTable({
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    operation_hash: v.string(),
    lease_expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_tenant", ["organization_id", "owner_user_id"]),

  workgraph_outbox: defineTable({
    ...workGraphOwner,
    id: v.string(),
    operation_id: v.string(),
    stream_id: v.optional(v.string()),
    effect_type: v.string(),
    idempotency_key: v.string(),
    payload: v.any(),
    status: v.string(),
    available_at: v.number(),
    attempt_count: v.number(),
    claimed_by: v.optional(v.string()),
    claim_expires_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    ...workGraphCreated,
    updated_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_idempotency", ["organization_id", "owner_user_id", "idempotency_key"])
    .index("by_status_available", ["status", "available_at"])
    .index("by_status_claim_expiry", ["status", "claim_expires_at"])
    .index("by_tenant_status_available", ["organization_id", "owner_user_id", "status", "available_at"]),

  workgraph_due_jobs: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.optional(v.string()),
    job_type: v.string(),
    subject_id: v.string(),
    due_at: v.number(),
    status: v.string(),
    payload: v.any(),
    lease_epoch: v.number(),
    claimed_by: v.optional(v.string()),
    claim_expires_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_subject", ["organization_id", "owner_user_id", "job_type", "subject_id"])
    .index("by_tenant_status_due", ["organization_id", "owner_user_id", "status", "due_at"]),

  workgraph_master_mailbox: defineTable({
    ...workGraphOwner,
    stream_id: v.string(),
    id: v.string(),
    message: v.string(),
    provenance: v.any(),
    status: v.string(),
    ...workGraphCreated,
    updated_at: v.number(),
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_stream_status", ["organization_id", "owner_user_id", "stream_id", "status", "created_at"]),

  workgraph_cleanup_receipts: defineTable({
    ...workGraphOwner,
    id: v.string(),
    idempotency_key: v.string(),
    effect_type: v.string(),
    result: v.any(),
    ...workGraphCreated,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_idempotency", ["organization_id", "owner_user_id", "idempotency_key"]),

  workgraph_migration_intake: defineTable({
    ...workGraphOwner,
    id: v.string(),
    legacy_table: v.string(),
    legacy_record_id: v.string(),
    intake_kind: v.string(),
    reason: v.string(),
    raw_reference: v.any(),
    status: v.string(),
    resolution: v.optional(v.any()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_legacy", ["organization_id", "owner_user_id", "legacy_table", "legacy_record_id"])
    .index("by_tenant_status_created", ["organization_id", "owner_user_id", "status", "created_at"]),

  // Legacy rows whose organization cannot be selected without guessing are
  // isolated here by the WorkGraph tenancy migration. Runtime code never
  // reads this table as WorkGraph state and never dual-reads unscoped rows.
  workgraph_tenancy_migration_quarantine: defineTable({
    table_name: v.string(),
    record_id: v.string(),
    owner_user_id: v.id("users"),
    candidate_organization_ids: v.array(v.id("orgs")),
    reason: v.union(v.literal("missing_organization"), v.literal("ambiguous_organization")),
    record: v.any(),
    quarantined_at: v.number(),
  })
    .index("by_record", ["table_name", "record_id"])
    .index("by_owner", ["owner_user_id"]),

  // Server-attested, tenant-bound execution capability catalog. Settings
  // writes and Attempt admission validate against this exact snapshot; a
  // missing or stale tenant snapshot fails closed.
  workgraph_execution_capabilities: defineTable({
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    schema_version: v.literal(1),
    catalog: v.any(),
    // Optional only for expand-safe deployment over pre-freshness rows. Runtime
    // reads reject rows without this attestation metadata, so legacy data never
    // participates in settings validation or Attempt admission.
    catalog_revision: v.optional(v.string()),
    observed_at: v.number(),
    expires_at: v.optional(v.number()),
    attested_at: v.number(),
  }).index("by_tenant", ["organization_id", "owner_user_id"]),

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

  // @claxedo/wakes durable rows (the Convex `WakeStore` adapter, wakes-v2 plan
  // 2026-07-17-002 U5). Column names mirror the SQLite store; absent optional
  // = the port's null. `id` is the engine-generated durable wake id — Convex
  // `_id` stays internal to this adapter.
  wakes: defineTable({
    id: v.string(),
    session_id: v.optional(v.string()),
    workspace_id: v.string(),
    trigger_type: v.string(),
    kind: v.string(),
    serial_key: v.optional(v.string()),
    intent_json: v.string(),
    result_json: v.optional(v.string()),
    state: v.string(),
    expires_at: v.optional(v.number()),
    depth: v.number(),
    created_by: v.optional(v.string()),
    created_at: v.number(),
    fired_at: v.optional(v.number()),
    fire_at: v.optional(v.number()),
    schedule: v.optional(v.string()),
    event_key: v.optional(v.string()),
    token: v.optional(v.string()),
    prompt: v.optional(v.string()),
    resolved_by: v.optional(v.string()),
    idempotency_key: v.optional(v.string()),
    lease_until: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_wake_id", ["id"])
    .index("by_idempotency", ["workspace_id", "idempotency_key"])
    .index("by_due", ["trigger_type", "state", "fire_at"])
    .index("by_lane_state", ["serial_key", "state"])
    .index("by_token", ["token"])
    .index("by_session", ["session_id"])
    .index("by_event_state", ["event_key", "state"])
    .index("by_state_expiry", ["state", "expires_at"])
    .index("by_state_lease", ["state", "lease_until"])
    .index("by_workspace_state", ["workspace_id", "state"])
    .index("by_workspace_created", ["workspace_id", "created_at"]),

  wake_receipts: defineTable({
    key: v.string(),
    result_json: v.string(),
    created_at: v.number(),
  }).index("by_key", ["key"]),
})
