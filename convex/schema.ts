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
const workGraphMasterStatusShape = {
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
}

export default defineSchema({
  users: defineTable({
    public_id: v.optional(v.string()),
    token_identifier: v.string(),
    clerk_subject: v.optional(v.string()),
    issuer: v.optional(v.string()),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    image_url: v.optional(v.string()),
    // EXPAND: legacy rows may not carry an actor kind until
    // migrations:backfillUserActorIdentity completes on every deployment.
    kind: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    // Compatibility envelope for rows written before the hosted remote-access
    // switch moved out of the user document.
    remote_access_enabled: v.optional(v.boolean()),
    /**
     * W5 activation (metric spec §4.5). Stamped ONCE, by the first
     * `llm_turn_completed` with `turn_status: "ok"`
     * (`usageMetering.recordLlmTurn`). Absent = not yet activated. The
     * check-and-set is the idempotence mechanism: a second ok turn observes a
     * present value and leaves it alone, so `user_activated` fires exactly
     * once per user for all time.
     */
    first_activated_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_public_id", ["public_id"])
    .index("by_token_identifier", ["token_identifier"])
    .index("by_clerk_subject", ["clerk_subject"]),

  orgs: defineTable({
    clerk_org_id: v.optional(v.string()),
    slug: v.optional(v.string()),
    name: v.string(),
    kind: v.optional(v.union(v.literal("personal"), v.literal("clerk"), v.literal("team"))),
    owner_user_id: v.optional(v.id("users")),
    deleted_at: v.optional(v.number()),
    clerk_updated_at: v.optional(v.number()),
    // ── B1 billing mirror (D5; ADR 014 §3) ──
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
    /**
     * §6.12 org cascade — the PURGE REQUEST clock.
     *
     * Set ONLY by the Svix-verified `organization.deleted` applier
     * (convex/orgs.ts), alongside `deleted_at`. Nothing else writes it, and
     * `upsertClerkOrg` CLEARS it on any later `organization.created/updated`,
     * so an org restored inside the grace window cancels its own purge.
     *
     * `deleted_at` alone is an access flag — `directOrgRole` stops resolving a
     * role, so the data becomes unreachable but is retained forever. This field
     * is the separate, explicit statement that the rows themselves must go, and
     * it is the clock the retention grace window measures from. Both must be
     * present before anything is destroyed.
     */
    purge_requested_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_clerk_org_id", ["clerk_org_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_polar_customer_id", ["polar_customer_id"])
    // ── W5 index pass (cf-reliability review A3) ──
    //
    // The three sweeps below each scanned the WHOLE `orgs` table to find the
    // handful of rows carrying an optional marker field. Convex caps documents
    // read per transaction, so those do not get slower as the table grows —
    // they THROW, and they throw on a cron where nobody is watching.
    //
    // Each index is on the optional field the sweep selects by. A document that
    // lacks the field is still in the index (it sorts at `undefined`, before
    // every other value), so `q.gt(field, undefined)` is an exact "rows that
    // have this field at all" range — the sweeps' actual predicate — and reads
    // only those rows rather than the table.
    // `flagStaleBillingSync` reuses the existing `by_polar_customer_id` for the
    // same reason — no compound index can help it, because Convex requires
    // `.eq` on a leading field before ranging a later one, and that query has
    // no single customer id to pin. Its staleness cutoff stays a JS filter over
    // the PAYING orgs, which is the bounded set.
    .index("by_billing_reconcile_flagged_at", ["billing_reconcile_flagged_at"])
    .index("by_polar_subscription_id", ["polar_subscription_id"])
    .index("by_purge_requested_at", ["purge_requested_at"]),

  // ── §6.12 org deletion cascade (convex/orgs.ts) ──
  //
  // Deliberate mirror of `workgraph_owner_deletion_receipts` /
  // `workgraph_owner_deletion_barriers`: a transient barrier that is the
  // transaction-visible fence while a batched purge runs, plus a durable
  // receipt that outlives the org row and therefore carries HASHES only.

  /**
   * The durable record of one org purge. `org_key_hash` is
   * `sha256(orgDocId \0 clerkOrgId)` and `operation_hash` is `sha256(operationId)`
   * — the org row is deleted by the purge, so a receipt holding the real ids
   * would be the one place the deleted tenant's identity survived.
   */
  org_deletion_receipts: defineTable({
    org_key_hash: v.string(),
    operation_hash: v.string(),
    state: v.union(v.literal("deleting"), v.literal("completed")),
    /**
     * `sha256(orgDocId \0 clerkOrgId \0 purge_requested_at)` — the fingerprint
     * of the PURGE REQUEST, not of the row set. Stable across batches (so a
     * resumed purge still verifies) while a restore-then-delete produces a new
     * `purge_requested_at` and therefore a new fingerprint, which a stale
     * receipt can never match.
     */
    scope_hash: v.string(),
    result: v.optional(
      v.object({
        deleted: v.literal(true),
        recordCount: v.number(),
        completedAt: v.number(),
      }),
    ),
    deleted_record_count: v.optional(v.number()),
    lease_expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_org_operation", ["org_key_hash", "operation_hash"])
    .index("by_org_key", ["org_key_hash"]),

  /** Write fence for an in-flight org purge. Removed by finalize or release. */
  org_deletion_barriers: defineTable({
    org_id: v.id("orgs"),
    operation_hash: v.string(),
    lease_expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_org", ["org_id"]),

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
    // EXPAND: these become required only in the contract release after the
    // workspace tenancy migration ledger is complete everywhere.
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
    .index("by_project", ["project_id"])
    .index("by_workspace_id", ["workspace_id"]),

  projects: defineTable({
    // EXPAND: current writers use the snake_case identity below while the
    // migration accepts the legacy camelCase project document unchanged.
    project_id: v.optional(v.string()),
    org_id: v.optional(v.id("orgs")),
    repo_key: v.optional(v.string()),
    owner_user_id: v.optional(v.id("users")),
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
    .index("by_org_repo_key", ["org_id", "repo_key"])
    .index("by_owner", ["owner_user_id"]),

  project_memberships: defineTable({
    // EXPAND: old rows point at the Convex project document; current rows use
    // the stable public project id. The migration reconciles both shapes.
    project_id: v.union(v.id("projects"), v.string()),
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
    .index("by_org", ["granted_to_org_id"])
    .index("by_workspace_user", ["workspace_id", "granted_to_user_id"])
    .index("by_workspace_org", ["workspace_id", "granted_to_org_id"]),

  local_host_links: defineTable({
    workspace_id: v.id("workspaces"),
    owner_user_id: v.id("users"),
    host_id: v.optional(v.string()),
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

  // Machine-wide remote access (Unit 6). One row per (owner, machine) — NOT
  // per workspace, which is the whole difference from local_host_links above.
  // A user with twelve projects on one laptop enrolls the laptop once; which
  // workspaces a session may reach is decided at request time from the
  // workspace tables rather than frozen into a registration row.
  //
  // Convex has no unique constraints, so `by_owner_host` is how that rule is
  // enforced: every write path reads through it first and patches rather than
  // inserts. The SQLite authority states the same rule as a UNIQUE.
  host_enrollments: defineTable({
    enrollment_id: v.string(),
    owner_user_id: v.id("users"),
    host_id: v.optional(v.string()),
    public_key: v.string(),
    display_name: v.optional(v.string()),
    last_seen_at: v.number(),
    expires_at: v.number(),
    paused_at: v.optional(v.number()),
    paused_by: v.optional(v.union(v.literal("user"), v.literal("killswitch"))),
    paused_reason: v.optional(v.string()),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_owner_host", ["owner_user_id", "host_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_host_id", ["host_id"])
    .index("by_expires_at", ["expires_at"]),

  // The one-use nonce a machine signs to prove it holds the private key.
  // Separate from host_attestation_challenges because that table is keyed by
  // workspace and this flow has no workspace to key by.
  host_enrollment_requests: defineTable({
    request_id: v.string(),
    owner_user_id: v.id("users"),
    host_id: v.string(),
    nonce: v.string(),
    expires_at: v.number(),
    used_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_request_id", ["request_id"])
    .index("by_owner", ["owner_user_id"])
    // `hostEnrollments.sweepExpired`'s range. `expires_at` is the
    // COLLECTABLE-AT clock, not just challenge validity: consumption pushes it
    // out to `used_at + ENROLLMENT_CONSUMED_RETENTION_MS` so one index answers
    // for both live nonces and retained consumed evidence.
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
    project_id: v.optional(v.union(v.id("projects"), v.string())),
    created_by_user_id: v.optional(v.id("users")),
    title: v.optional(v.string()),
    directory_hint: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    max_event_ordinal: v.optional(v.number()),
    deleted_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_created_by_user", ["created_by_user_id"])
    .index("by_workspace_updated", ["workspace_id", "updated_at"]),

  session_messages: defineTable({
    session_id: v.string(),
    workspace_id: v.id("workspaces"),
    message_id: v.string(),
    author_actor_id: v.optional(v.id("users")),
    role: v.optional(v.string()),
    ordinal: v.number(),
    data: v.any(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_session_ordinal", ["session_id", "ordinal"])
    .index("by_message_id", ["message_id"]),

  session_participants: defineTable({
    session_id: v.string(),
    workspace_id: v.id("workspaces"),
    user_id: v.id("users"),
    added_by_user_id: v.id("users"),
    created_at: v.number(),
    revoked_at: v.optional(v.number()),
  })
    .index("by_session_user", ["session_id", "user_id"])
    .index("by_user", ["user_id"]),

  runtime_access_tokens: defineTable({
    jti: v.string(),
    workspace_id: v.optional(v.id("workspaces")),
    workspace_public_id: v.optional(v.string()),
    host_id: v.string(),
    minted_for_user_id: v.optional(v.id("users")),
    minted_for_subject: v.optional(v.string()),
    principal_kind: v.optional(v.union(v.literal("user"), v.literal("service"))),
    minted_for_actor_id: v.optional(v.string()),
    minted_for_actor_kind: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    // EXPAND: tokens minted before live role validation do not carry the role
    // that was signed into the RAT. `runtimeAccessTokens.active` fails those
    // legacy rows closed; the maximum RAT lifetime bounds the rollout window.
    workspace_role: v.optional(workspaceRole),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_jti", ["jti"])
    .index("by_workspace_user", ["workspace_id", "minted_for_user_id"]),

  // Revocation registry for CLI session tokens (`claxedo login` credentials).
  //
  // Deliberately NOT `runtime_access_tokens`: that table requires BOTH a
  // `workspace_id` and a `host_id`, and its `active` check matches on both. A
  // CLI session token has neither — it is minted at `/api/auth/cli/exchange`
  // before any workspace exists and authenticates the HUMAN, everywhere. Its
  // identity is the (`jti`, owner) pair plus the login chain it belongs to.
  //
  // `token_identifier` is the stable per-user key (the same value Clerk hands
  // `users.token_identifier`) rather than `v.id("users")`, because the mint and
  // rotation paths are service-authenticated and must not depend on a user row
  // existing yet — and because it is exactly the field every revocation is
  // scoped by, which is what stops one user revoking another's sessions.
  cli_session_tokens: defineTable({
    jti: v.string(),
    kind: v.union(v.literal("access"), v.literal("refresh")),
    token_identifier: v.string(),
    subject: v.string(),
    // Login-chain id: every access/refresh pair descended from one
    // `claxedo login` shares it, so a device can be signed out as a unit.
    session_id: v.string(),
    // Expiry of THIS token; `session_expires_at` is the chain's absolute
    // deadline, which rotation carries through and may never extend.
    expires_at: v.number(),
    session_expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_jti", ["jti"])
    // Owner-scoped from the leading field so a chain lookup can never span
    // users: `revokeSession` reads (owner, chain), never chain alone.
    .index("by_user_session", ["token_identifier", "session_id"])
    .index("by_token_identifier", ["token_identifier"])
    // Reaper key. A row is dead once its own token expires — an expired JWT
    // fails signature verification before the registry is ever consulted.
    .index("by_expires_at", ["expires_at"]),

  runtime_leases: defineTable({
    workspace_id: v.string(),
    home_region: v.string(),
    // ── W5 sandbox-compute metering (metric spec §4.2) ──
    // Lease rows carried a workspace and a sandbox but no tenant and no clock,
    // which made "how much sandbox compute does my average user consume?"
    // unanswerable as a matter of missing columns rather than a missing query.
    //
    // These are the CLERK-issued subject/org strings the control plane already
    // holds on the signed request that created the lease — the same id space
    // the product-plane PostHog events key on — not `v.id("orgs")`/`v.id("users")`
    // references, matching this table's existing string `workspace_id`.
    //
    // All optional: a pure EXPAND step
    // (docs/tech-docs/convex-schema-evolution.md), so every pre-W5 row stays
    // valid and no migration is required. Rows written before this ships have
    // no tenant and are excluded from the rollup by construction.
    org_id: v.optional(v.string()),
    user_id: v.optional(v.string()),
    /**
     * The Clerk SUBJECT of the caller whose signed request caused this lease —
     * the concurrency cap's attribution key, deliberately separate from the W5
     * metering pair above.
     *
     * `org_id`/`user_id` are only ever written TOGETHER, because a metering
     * fact keyed on a fabricated org silently corrupts every per-org aggregate
     * (see `closeLeaseInterval`). A personal-account token carries no `org_id`
     * claim, so those leases are unattributable for metering BY DESIGN — and
     * that made `countActiveForOrg` unable to see them, so the per-org
     * concurrent-sandbox cap could not bind for personal accounts at all.
     *
     * A subject claim, unlike an org claim, is present on EVERY signed request.
     * Recording it here gives the cap a total attribution key without inventing
     * an org: this column never reaches `sandbox_lease_events` or the rollups,
     * so W5 semantics are untouched by construction.
     */
    owner_subject: v.optional(v.string()),
    /** Wall-clock of the CURRENT open interval, re-stamped on every acquire. */
    started_at: v.optional(v.number()),
    /** Set when the lease closes; cleared by the next acquire. */
    ended_at: v.optional(v.number()),
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
    checkpoint: v.optional(v.any()),
    persistence_capabilities: v.optional(v.any()),
    restore_status: v.optional(v.any()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_id", ["workspace_id"])
    .index("by_status", ["status"])
    .index("by_host_id", ["host_id"])
    .index("by_updated_at", ["updated_at"])
    // ── W5 index pass (cf-reliability review A3) ──
    //
    // `countActiveForOrg` runs on EVERY hosted workspace create and scanned the
    // whole table. Beyond the read cap, a full-table read-set means any lease
    // heartbeat OCC-conflicts with any concurrent create — the cap's own
    // enforcement was the thing serializing creates.
    //
    // Two indexes because the count has two scopes, deliberately: `org_id` is
    // the org's leases, `owner_subject` is one signed caller's, and a
    // personal-account token carries no org claim (see the field comments
    // above). Both are compound on `status` so the live statuses are an index
    // range, not a post-filter — `isLiveLease` still re-checks `ended_at`,
    // which is a per-row fact no index can express.
    .index("by_org_status", ["org_id", "status"])
    .index("by_owner_subject_status", ["owner_subject", "status"]),

  // ── W5 metering fact + rollup tables (metric spec §4.2, §4.3; plan D1/D3) ──
  //
  // D1: these tables are AUTHORITATIVE. PostHog carries the same events for
  // analysis, but every `capture()` in this codebase is best-effort by design
  // (a dropped event must never break the operation it observes) — correct for
  // product analytics, wrong for a number a paid plan may later be gated on.
  // So the money-grade numbers land here and PostHog is the view.
  //
  // D3 retention: the two FACT tables (`sandbox_lease_events`,
  // `llm_usage_events`) are pruned at 400 days by
  // `usageMetering.pruneUsageFacts`; the `sandbox_usage_daily` ROLLUP is kept
  // indefinitely, so the long-range answer survives the prune.
  //
  // Every one of these ships a reader (`usageMetering.leaseEventsForSandbox`,
  // `llmUsageForSession`, `llmUsageTotals`, `sandboxUsageDaily`) — the rule
  // `audit_events` used to break, and no longer does (§6.11: it now ships
  // `auditEvents.listForWorkspace` / `listMine` / `listForOrg`).

  /**
   * One row per CLOSED lease interval — the raw sandbox-compute fact.
   *
   * `runtime_leases` is one mutable row per workspace that is deleted on
   * release, so it can hold the CURRENT interval but never the history a
   * rollup needs. This table is that history.
   */
  sandbox_lease_events: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    workspace_id: v.string(),
    sandbox_id: v.optional(v.string()),
    driver: v.string(),
    started_at: v.number(),
    ended_at: v.number(),
    /** `ended_at - started_at`, computed at close from one clock. */
    active_ms: v.number(),
    reason: v.union(v.literal("idle_timeout"), v.literal("explicit_release"), v.literal("gc")),
    /** `YYYY-MM-DD` (UTC) of `ended_at`; the rollup's grouping key. */
    date: v.string(),
    /** Set by the rollup so a re-run is idempotent rather than double-counting. */
    rolled_up_at: v.optional(v.number()),
    created_at: v.number(),
  })
    .index("by_sandbox_id", ["sandbox_id"])
    .index("by_workspace_id", ["workspace_id"])
    .index("by_date", ["date"])
    .index("by_created_at", ["created_at"])
    // ── W5 index pass (cf-reliability review A3) ──
    //
    // The rollup consumes UNROLLED facts, and this is a fact table that only
    // ever grows: it read every lease event ever recorded to find the handful
    // written since the last hourly tick. `rolled_up_at` is set as each fact is
    // consumed, so ranging at `undefined` reads exactly the pending queue —
    // which the rollup itself keeps drained — instead of all of history.
    .index("by_rolled_up_at", ["rolled_up_at"]),

  /** Daily rollup — answers Q1 as `AVG(total_active_seconds) GROUP BY date`. */
  sandbox_usage_daily: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    /** `YYYY-MM-DD`, UTC. */
    date: v.string(),
    driver: v.string(),
    total_active_seconds: v.number(),
    lease_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_bucket", ["org_id", "user_id", "date", "driver"])
    .index("by_org_date", ["org_id", "date"])
    .index("by_date", ["date"]),

  /** Latest authoritative revision per stable model turn. Legacy fields stay readable during backfill. */
  llm_usage_events: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    message_id: v.string(),
    session_id: v.string(),
    stream_id: v.optional(v.string()),
    run_id: v.optional(v.string()),
    work_item_id: v.optional(v.string()),
    harness: v.string(),
    provider_id: v.string(),
    model_id: v.string(),
    host_id: v.optional(v.string()),
    session_ref: v.optional(v.string()),
    revision: v.optional(v.number()),
    payload_hash: v.optional(v.string()),
    observed_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
    settlement: v.optional(v.union(
      v.literal("provisional"), v.literal("final"), v.literal("partial"),
      v.literal("unavailable"), v.literal("recovered"),
    )),
    status: v.optional(v.union(
      v.literal("running"), v.literal("completed"), v.literal("error"), v.literal("stopped"),
      v.literal("interrupted_by_steer"), v.literal("process_lost"),
    )),
    location: v.optional(v.union(
      v.literal("local"), v.literal("central"), v.literal("cloud-workspace"), v.literal("user-hosted"),
    )),
    workspace_id: v.optional(v.string()),
    quality: v.optional(v.object({
      source: v.union(v.literal("provider"), v.literal("provider-message"), v.literal("lifecycle"), v.literal("legacy")),
      observation_kind: v.optional(v.union(v.literal("cumulative"), v.literal("delta"))),
      provider_observation_id: v.optional(v.string()),
      known_categories: v.array(v.union(
        v.literal("input"), v.literal("output"), v.literal("reasoning"),
        v.literal("cache_read"), v.literal("cache_write"),
      )),
    })),
    input_tokens: v.union(v.number(), v.null()),
    output_tokens: v.union(v.number(), v.null()),
    reasoning_tokens: v.union(v.number(), v.null()),
    cache_read_tokens: v.union(v.number(), v.null()),
    cache_write_tokens: v.union(v.number(), v.null()),
    turn_status: v.optional(v.union(v.literal("ok"), v.literal("error"))),
    latency_ms: v.optional(v.number()),
    usage_rolled_up_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_org_message", ["org_id", "message_id"])
    .index("by_org_session_ref_message", ["org_id", "session_ref", "message_id"])
    .index("by_org_user", ["org_id", "user_id"])
    .index("by_org_observed", ["org_id", "observed_at"])
    .index("by_org_user_observed", ["org_id", "user_id", "observed_at"])
    .index("by_org_stream_created", ["org_id", "stream_id", "created_at", "message_id"])
    .index("by_usage_rolled_up_at", ["usage_rolled_up_at"])
    .index("by_created_at", ["created_at"]),

  /** Immutable accepted revisions for repair/audit; dashboard totals never sum this table. */
  llm_usage_revisions: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    host_id: v.optional(v.string()),
    session_ref: v.string(),
    session_id: v.string(),
    message_id: v.string(),
    stream_id: v.optional(v.string()),
    run_id: v.optional(v.string()),
    work_item_id: v.optional(v.string()),
    revision: v.number(),
    payload_hash: v.string(),
    observed_at: v.number(),
    completed_at: v.optional(v.number()),
    settlement: v.union(
      v.literal("provisional"), v.literal("final"), v.literal("partial"),
      v.literal("unavailable"), v.literal("recovered"),
    ),
    status: v.union(
      v.literal("running"), v.literal("completed"), v.literal("error"), v.literal("stopped"),
      v.literal("interrupted_by_steer"), v.literal("process_lost"),
    ),
    location: v.union(
      v.literal("local"), v.literal("central"), v.literal("cloud-workspace"), v.literal("user-hosted"),
    ),
    harness: v.string(),
    provider_id: v.string(),
    model_id: v.string(),
    workspace_id: v.optional(v.string()),
    input_tokens: v.union(v.number(), v.null()),
    output_tokens: v.union(v.number(), v.null()),
    reasoning_tokens: v.union(v.number(), v.null()),
    cache_read_tokens: v.union(v.number(), v.null()),
    cache_write_tokens: v.union(v.number(), v.null()),
    quality: v.object({
      source: v.union(v.literal("provider"), v.literal("provider-message"), v.literal("lifecycle"), v.literal("legacy")),
      observation_kind: v.optional(v.union(v.literal("cumulative"), v.literal("delta"))),
      provider_observation_id: v.optional(v.string()),
      known_categories: v.array(v.union(
        v.literal("input"), v.literal("output"), v.literal("reasoning"),
        v.literal("cache_read"), v.literal("cache_write"),
      )),
    }),
    created_at: v.number(),
  })
    .index("by_turn_revision", ["org_id", "session_ref", "message_id", "revision"])
    .index("by_created_at", ["created_at"]),

  /** Transactionally maintained bounded headline/daily projection. */
  llm_usage_daily: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    date: v.string(),
    turn_count: v.number(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    reasoning_tokens: v.number(),
    cache_read_tokens: v.number(),
    cache_write_tokens: v.number(),
    input_known_count: v.number(),
    output_known_count: v.number(),
    reasoning_known_count: v.number(),
    cache_read_known_count: v.number(),
    cache_write_known_count: v.number(),
    partial_turn_count: v.number(),
    unavailable_turn_count: v.number(),
    error_turn_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_bucket", ["org_id", "user_id", "date"])
    .index("by_org_date", ["org_id", "date"]),

  /** Transactionally maintained daily dimensions for bounded group queries. */
  llm_usage_breakdown_daily: defineTable({
    org_id: v.string(),
    user_id: v.string(),
    date: v.string(),
    dimension: v.union(
      v.literal("provider"), v.literal("harness"), v.literal("model"), v.literal("location"),
      v.literal("session"), v.literal("workspace"),
    ),
    value: v.string(),
    turn_count: v.number(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    reasoning_tokens: v.number(),
    cache_read_tokens: v.number(),
    cache_write_tokens: v.number(),
    known_token_count: v.number(),
    unknown_token_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_bucket", ["org_id", "user_id", "date", "dimension", "value"])
    .index("by_org_user_dimension_date", ["org_id", "user_id", "dimension", "date"])
    .index("by_org_user_dimension_value_date", ["org_id", "user_id", "dimension", "value", "date"]),

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
    parent_stream_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    charter: v.optional(v.object({ text: v.string(), hash: v.string() })),
    master_status: v.optional(v.object({
      ...workGraphMasterStatusShape,
      budgetPriorStatus: v.optional(v.object(workGraphMasterStatusShape)),
    })),
    notes_source: v.optional(workSourceRevisionRef),
    public_pr_confirmed_at: v.optional(v.number()),
    lifecycle_state: v.string(),
    visibility: v.string(),
    pinned: v.boolean(),
    execution_defaults: v.any(),
    spend: v.optional(v.object({
      total_usd: v.optional(v.number()),
      total_tokens: v.number(),
      by_profile: v.optional(v.array(v.object({
        profile: v.string(),
        total_usd: v.optional(v.number()),
        total_tokens: v.number(),
      }))),
      as_of: v.number(),
      as_of_message_id: v.optional(v.string()),
      day_start: v.optional(v.number()),
      day_usd: v.optional(v.number()),
      day_tokens: v.optional(v.number()),
    })),
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
    .index("by_tenant_parent", ["organization_id", "owner_user_id", "parent_stream_id"])
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
    parent_task_id: v.optional(v.string()),
    outcome_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    state: v.string(),
    priority: v.number(),
    source_revision_refs: v.array(workSourceRevisionRef),
    completion_contract: v.any(),
    evidence_ids: v.array(v.string()),
    execution_defaults: v.optional(v.any()),
    // Approval-gate origin provenance. The actor that materialized the task
    // decides its born state (agent-created tasks start `pending_approval`
    // i.e. "Staged"; human-created/confirmed tasks start `pending`, already
    // approved); these fields carry the audit trail so the UI/archive can
    // attribute agent-created work. Optional and backfill-free — legacy rows
    // read as unknown origin.
    created_by_actor_type: v.optional(v.string()),
    created_by_actor_id: v.optional(v.string()),
    origin_run_id: v.optional(v.string()),
    auto_admitted: v.optional(v.boolean()),
    abandoned_at: v.optional(v.number()),
    abandon_reason: v.optional(v.string()),
    completed_at: v.optional(v.number()),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_parent", ["organization_id", "owner_user_id", "parent_task_id"])
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

  workgraph_runs: defineTable({
    ...workGraphOwner,
    id: v.string(),
    stream_id: v.string(),
    work_item_id: v.string(),
    run_number: v.number(),
    generation: v.number(),
    state: v.string(),
    execution_kind: v.optional(v.union(v.literal("managed"), v.literal("attached"))),
    resolved_execution: v.any(),
    admitted_at: v.number(),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
    result: v.optional(v.any()),
    parked_reason: v.optional(v.string()),
    resume_attempts: v.optional(v.number()),
    envelope_id: v.optional(v.string()),
    child_workspace_id: v.optional(v.string()),
    session_id: v.optional(v.string()),
    completion_retry: v.optional(v.object({ terminal_seq: v.number(), requested_at: v.number() })),
    cancellation: v.optional(v.object({
      state: v.union(v.literal("pending"), v.literal("attention"), v.literal("completed")),
      requestedAt: v.optional(v.number()),
      reason: v.optional(v.string()),
      compensationSessionId: v.optional(v.string()),
      at: v.optional(v.number()),
      completedAt: v.optional(v.number()),
    })),
    source_revision_refs: v.array(workSourceRevisionRef),
    provenance: v.any(),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_id", ["organization_id", "owner_user_id", "id"])
    .index("by_tenant_created_id", ["organization_id", "owner_user_id", "created_at", "id"])
    .index("by_tenant_stream", ["organization_id", "owner_user_id", "stream_id"])
    .index("by_tenant_item_run", ["organization_id", "owner_user_id", "work_item_id", "run_number"])
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
    current_run_id: v.optional(v.string()),
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
    run_id: v.string(),
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

  // Secret-free references used to authorize one Run's callback-scoped
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

  workgraph_run_connection_bindings: defineTable({
    ...workGraphOwner,
    run_id: v.string(),
    session_id: v.string(),
    workspace_id: v.string(),
    connection_ids: v.array(v.string()),
    tools: v.array(v.string()),
    revoked_at: v.optional(v.number()),
    ...workGraphMutable,
  })
    .index("by_tenant", ["organization_id", "owner_user_id"])
    .index("by_tenant_run", ["organization_id", "owner_user_id", "run_id"])
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
    run_id: v.optional(v.string()),
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
    .index("by_tenant_resource_created_id", ["organization_id", "owner_user_id", "resource_type", "resource_id", "created_at", "id"])
    .index("by_tenant_stream_cursor", ["organization_id", "owner_user_id", "stream_id", "cursor"]),

  workgraph_dirty_events: defineTable({
    ...workGraphOwner,
    dirty_at: v.number(),
    dirty_token: v.string(),
    drained_at: v.optional(v.number()),
  })
    .index("by_token", ["organization_id", "owner_user_id", "dirty_token"])
    .index("by_dirty", ["drained_at", "dirty_at"])
    .index("by_drained", ["drained_at"]),

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
  // writes and Run admission validate against this exact snapshot; a
  // missing or stale tenant snapshot fails closed.
  workgraph_execution_capabilities: defineTable({
    organization_id: v.id("orgs"),
    owner_user_id: v.id("users"),
    schema_version: v.literal(1),
    catalog: v.any(),
    // Optional only for expand-safe deployment over pre-freshness rows. Runtime
    // reads reject rows without this attestation metadata, so legacy data never
    // participates in settings validation or Run admission.
    catalog_revision: v.optional(v.string()),
    observed_at: v.number(),
    expires_at: v.optional(v.number()),
    attested_at: v.number(),
  }).index("by_tenant", ["organization_id", "owner_user_id"]),

  audit_events: defineTable({
    user_id: v.optional(v.id("users")),
    org_id: v.optional(v.id("orgs")),
    workspace_id: v.optional(v.id("workspaces")),
    // Public opaque project id, matching every other table's convention. Was
    // v.id("projects") — the lone outlier — but no writer sets it, so aligning
    // the type is safe (all existing rows have it absent).
    project_id: v.optional(v.string()),
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

  // @claxedo/wakes durable rows (the Convex `WakeStore` adapter). Column
  // names mirror the SQLite store; absent optional = the port's null. `id`
  // is the engine-generated durable wake id — Convex `_id` stays internal to
  // this adapter.
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

  // ── W6.3 Clerk membership drift (cf-reliability review W6.3) ──
  //
  // Memberships are mirrored from Clerk by webhook ONLY, and the runtime authz
  // path treats the Convex row as the SOLE authority (`model.ts orgAdminForUser`
  // — JWT org claims are deliberately untrusted). So a membership row that
  // Clerk no longer has is not stale data, it is a removed employee holding
  // org-admin access indefinitely. The two tables below are what make the
  // mirror self-correcting instead of hoping every Svix delivery lands.

  /**
   * A revoked (org, user) membership, remembered so a LATE `.created` cannot
   * resurrect it.
   *
   * The bug this closes: `upsertClerkMembership` guards replay by comparing
   * `clerk_updated_at` against the EXISTING row, so once `.deleted` has removed
   * that row there is nothing left to compare against — a delayed
   * `organizationMembership.created` redelivery arriving afterwards simply
   * re-inserts the membership, restoring access Clerk already revoked. Svix
   * retries a failing endpoint for ~27.5h and only disables it after 5 days of
   * failures, so a redelivery arriving days after the event it describes is
   * ordinary webhook behavior, not a pathological case.
   *
   * Keyed on the CLERK ids rather than Convex document ids, for two independent
   * reasons: the delete path runs even when the org/user rows do not resolve
   * (so there may be no document id to key on), and a tombstone whose whole job
   * is to outlive the row it describes must not be keyed on that row.
   *
   * `clerk_updated_at` is the revocation's source timestamp — the same clock
   * `upsertClerkMembership` already compares — so the guard is a timestamp
   * comparison and NOT a permanent block: a genuine later re-join carries a
   * newer timestamp, wins, and clears the tombstone on its way through.
   */
  clerk_membership_tombstones: defineTable({
    clerk_org_id: v.string(),
    clerk_subject: v.string(),
    /**
     * Source timestamp of the revocation. On the webhook path this is the
     * Clerk event's own `updated_at`; on the sweep path it is the instant the
     * sweep OBSERVED Clerk's state without this membership in it, which bounds
     * staleness identically — a create older than that observation is stale by
     * construction.
     */
    clerk_updated_at: v.number(),
    source: v.union(v.literal("webhook"), v.literal("sweep")),
    created_at: v.number(),
  })
    .index("by_membership", ["clerk_org_id", "clerk_subject"])
    // TTL reaping (`clerkReconcile.reapMembershipTombstones`). Retention is
    // measured from when the tombstone was WRITTEN, not from the Clerk
    // timestamp, because it is the redelivery window that has to be outlasted.
    .index("by_created_at", ["created_at"]),

  /**
   * Deployment-wide Clerk mirror health, plus the sweep's round-robin cursor.
   * Exactly one row (`scope: "clerk"`); `by_scope` is how it is found.
   *
   * DEPLOYMENT-wide rather than per-org, and that is the whole design decision.
   * Billing's `flagStaleBillingSync` stamps `billing_synced_at` per org and
   * flags orgs whose mirror has gone quiet, which works because Polar state is
   * a standing fact that can be re-fetched per customer. Clerk membership
   * events are DIFFERENT: Clerk emits one only when a membership actually
   * changes, so a healthy org with a stable roster is silent for months. A
   * per-org staleness clock would therefore flag every quiet org — it would be
   * pure noise, and a noisy flag is one operators learn to ignore, which is
   * worse than not having it.
   *
   * The signal that is actually meaningful is the one Svix's failure mode
   * produces: an endpoint disabled after repeated delivery failures stops ALL
   * events at once. "No Clerk webhook of any type, deployment-wide, in X hours
   * despite active Clerk orgs existing" detects exactly that, and cannot fire
   * merely because one tenant's roster is stable.
   */
  clerk_sync_state: defineTable({
    scope: v.literal("clerk"),
    /** Wall-clock of the last Clerk webhook of ANY type applied. */
    last_webhook_at: v.optional(v.number()),
    /** Type of that event, so the flag can say what was last seen. */
    last_webhook_type: v.optional(v.string()),
    /** Set by the liveness sweep; CLEARED by the next webhook of any type. */
    webhook_stale_flagged_at: v.optional(v.number()),
    /**
     * Round-robin cursor: the `clerk_org_id` the last sweep run stopped at.
     * Absent = start from the beginning. Clerk org ids are strings and
     * `by_clerk_org_id` is ordered, so `.gt("clerk_org_id", cursor)` is an
     * exact "next page" — which is what lets a per-run org CAP still achieve
     * full coverage over successive runs instead of re-checking the same head
     * of the table forever.
     */
    sweep_cursor: v.optional(v.string()),
    last_sweep_at: v.optional(v.number()),
    last_sweep_orgs: v.optional(v.number()),
    last_sweep_corrections: v.optional(v.number()),
    /** Set when a run stopped early on a Clerk 429, cleared on a clean run. */
    last_sweep_rate_limited_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_scope", ["scope"]),

  /**
   * W4.2 — durable idempotency for control-plane operations (convex/idempotency.ts).
   *
   * Replaces the per-isolate `Map` in
   * `packages/claxedo-server/src/control-plane/http-idempotency.ts` as the
   * SOURCE OF TRUTH; that map stays in front of this as a same-isolate fast
   * path. Cloudflare runs many isolates, so the map alone let two isolates each
   * execute the same "idempotent" register/checkpoint/repair.
   *
   * `cache_key` is opaque and already scoped by the caller (operation +
   * principal + workspace + session, or a `polar-webhook:` prefix for W4.3), so
   * this table carries no tenant columns: it must dedupe unauthenticated
   * webhook deliveries too, which have no tenant at dedup time.
   *
   * `result_json` is the route's own response, stringified. Kept opaque so a
   * route-shape change is not a schema change.
   *
   * BOTH states carry `expires_at`, not just `completed` — an in-flight row with
   * no expiry is neither replayable nor collectable, which is the latent bug in
   * the in-memory version (a hung request wedged its key permanently).
   */
  control_idempotency: defineTable({
    cache_key: v.string(),
    /** Payload binding: same key + different payload is a conflict, never a replay. */
    fingerprint: v.string(),
    state: v.union(v.literal("in_flight"), v.literal("completed")),
    /** Live only while `state` is "in_flight"; zeroed on completion. */
    lease_expires_at: v.number(),
    /** Sweep/replay deadline. Set for in-flight rows too, deliberately. */
    expires_at: v.number(),
    result_json: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_cache_key", ["cache_key"])
    // Ranged by the sweep so its read set is bounded by EXPIRED rows rather
    // than by table size (W5's no-unbounded-read invariant).
    .index("by_state_expiry", ["state", "expires_at"]),

  /**
   * Durable OAuth/device connect attempts (convex/connectionAttempts.ts).
   *
   * Same class of bug as `control_idempotency` above, in the Connections
   * surface. `packages/claxedo-connections/src/attempts.ts` is an in-memory
   * `Map`, and the hosted control plane builds a FRESH connections service per
   * request (`hosts/workgraph/hosted/connections-setup.ts`). So
   * `POST /github/connect` wrote the attempt into one isolate's Map and
   * `GET /attempts/:state` read a different, empty one — every hosted OAuth and
   * device connect answered `attempt_not_found`, which is why a hosted user
   * could never finish connecting GitHub at all.
   *
   * ── What is and is not stored ──
   * `state` and `verifier` are this flow's OWN random values (32 bytes each,
   * minted per attempt and dead within the TTL), and `device_code` is the
   * provider-issued handle the host polls with. None of them is a credential
   * for anything: the access token a completed grant yields never touches this
   * table — it goes to the envelope-encrypted credential store, exactly as on
   * the local path. Everything here is short-lived by construction and
   * collected by `sweepExpired`.
   *
   * `completing` is the atomic-consume flag, carried through so a durable
   * attempt keeps the in-memory store's single-use semantics: a concurrent poll
   * cannot settle the same attempt twice, and a mid-consume row is left pending
   * past its TTL so a slow token exchange still reports its real outcome.
   */
  connection_attempts: defineTable({
    /** The opaque per-attempt id the client polls with; never a credential. */
    state: v.string(),
    /** PKCE verifier for the redirect flow; absent-of-meaning once terminal. */
    verifier: v.string(),
    integration_id: v.string(),
    /** Present only for device grants — the redirect flow gets its code on the callback. */
    device_code: v.optional(v.string()),
    owner: v.optional(v.string()),
    scope: v.union(v.literal("team"), v.literal("personal")),
    status: v.union(v.literal("pending"), v.literal("complete"), v.literal("failed"), v.literal("expired")),
    /** Mid-consume fence: only `settle` may move a row holding it. */
    completing: v.boolean(),
    message: v.optional(v.string()),
    /** TTL for a pending row; the sweep/retention deadline once terminal. */
    expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_state", ["state"])
    // Ranged by the sweep so its read set is bounded by expired rows rather
    // than by table size (W5's no-unbounded-read invariant).
    .index("by_status_expiry", ["status", "expires_at"]),

  /**
   * W4.4 — fenced cron lease (convex/cronLease.ts).
   *
   * One row per serialized cron body. Both existing reconcile guards
   * (`workgraph-host/reconcile-serialize.ts` and
   * `routes/hosted-workgraph-admin.ts`) are per-isolate closures, so two
   * isolates could both enter a body whose overlap once hung the Workers
   * runtime (staging run 29514161976).
   *
   * `lease_expires_at` is mandatory and `fence` is monotonic: the motivating
   * incident is a HANG, so a lease that could not be taken over would turn one
   * stalled isolate into a reconciler that never runs again.
   */
  cron_leases: defineTable({
    /** Logical lane name, e.g. "workgraph_reconcile". */
    name: v.string(),
    /** Opaque holder id — an isolate/invocation identity, not a tenant. */
    holder: v.string(),
    /** Advances on every acquisition, so a zombie holder's stale fence is detectable. */
    fence: v.number(),
    lease_expires_at: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_name", ["name"]),
})
