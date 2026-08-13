// D14 — Convex schema evolution discipline (ADR 016 §5): expand-migrate-contract is law, and the MIGRATE step runs
// exclusively through the @convex-dev/migrations component. The component
// gives every backfill the four things hand-rolled mutations re-solve badly —
// batching, resumability, idempotency (a migration never double-runs), and a
// durable per-deployment ledger of what ran. Setup follows the component
// README (https://github.com/get-convex/migrations): the component is
// registered in convex/convex.config.ts, migrations are defined here, and are
// run with `npx convex run migrations:run '{"fn": "migrations:<name>"}'` (or
// directly by name). Do NOT add new hand-rolled backfill mutations — see
// docs/tech-docs/convex-schema-evolution.md.
import { Migrations } from "@convex-dev/migrations"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { hasLegacyLeaseFields, legacyLeaseDocument } from "./sandboxLeases"
import { migrateLegacyLlmUsageRow } from "./usageMetering"
import { initializeAttentionProjection, syncAttentionRecord, syncCandidateTransition } from "./workgraphAttention"
import { canonicalRepoKey } from "./workspaces"

export const migrations = new Migrations<DataModel>(components.migrations)

// Generic runner: `npx convex run migrations:run '{"fn": "migrations:<name>"}'`.
export const run = migrations.runner()

// #001 — provider-era field names -> driver/driver_resource_id on
// runtime_leases. The schema accepts both shapes during the expand and migrate
// phases. The component ledger records completion before a later contract
// release removes the optional legacy fields.
export const normalizeRuntimeLeaseLegacyFields = migrations.define({
  table: "runtime_leases",
  migrateOne: async (ctx, lease) => {
    const row = lease as Record<string, unknown>
    if (!hasLegacyLeaseFields(row)) return
    await ctx.db.replace(lease._id, legacyLeaseDocument(row) as never)
  },
})

// Usage-ledger EXPAND -> MIGRATE. Legacy completed-turn rows need the public
// session reference, observed timestamp, quality metadata, rollups, and audit
// revision before the exact dashboard reader can include them.
export const backfillLegacyLlmUsage = migrations.define({
  table: "llm_usage_events",
  migrateOne: async (ctx, row) => {
    await migrateLegacyLlmUsageRow(ctx, row)
  },
})

// Single-tenant -> tenant-explicit rollout. These migrations deliberately
// remain separate ledger entries and must run in the documented order. Every
// transform is idempotent, preserves legacy fields for rollback, and refuses
// to guess when stored provenance admits more than one tenant.
export const backfillUserActorIdentity = migrations.define({
  table: "users",
  migrateOne: async (ctx, user) => {
    if (user.public_id && user.kind) return
    await ctx.db.patch(user._id, {
      public_id: user.public_id ?? `usr_${crypto.randomUUID()}`,
      kind: user.kind ?? "human",
    })
  },
})

export const backfillProjectTenantIdentity = migrations.define({
  table: "projects",
  migrateOne: migrateProjectTenantIdentity,
})

export const reconcileProjectMembershipProjectIds = migrations.define({
  table: "project_memberships",
  migrateOne: async (ctx, membership) => {
    const project = await projectFromStoredIdentity(ctx, membership.project_id)
    if (!project?.project_id) throw new Error(`project_membership_unresolved:${membership._id}`)
    if (membership.project_id === project.project_id) return
    const duplicate = await ctx.db
      .query("project_memberships")
      .withIndex("by_project_user", (query) => query.eq("project_id", project.project_id).eq("user_id", membership.user_id))
      .unique()
    if (duplicate && duplicate._id !== membership._id) {
      throw new Error(`project_membership_duplicate:${membership._id}:${duplicate._id}`)
    }
    await ctx.db.patch(membership._id, { project_id: project.project_id })
  },
})

export const backfillWorkspaceTenantIdentity = migrations.define({
  table: "workspaces",
  migrateOne: migrateWorkspaceTenantIdentity,
})

export const backfillSessionTenantIdentity = migrations.define({
  table: "session_history",
  migrateOne: async (ctx, session) => {
    const workspace = await ctx.db.get(session.workspace_id)
    if (!workspace) throw new Error(`session_workspace_missing:${session._id}`)
    if (!workspace.org_id || !workspace.project_id) {
      throw new Error(`session_workspace_not_migrated:${session._id}:${workspace._id}`)
    }
    const storedProject = session.project_id
      ? await projectFromStoredIdentity(ctx, session.project_id)
      : undefined
    if (session.project_id && !storedProject) throw new Error(`session_project_missing:${session._id}`)
    if (session.org_id && session.org_id !== workspace.org_id) {
      throw new Error(`session_workspace_tenant_conflict:${session._id}:${workspace._id}`)
    }
    if (storedProject?.org_id && storedProject.org_id !== workspace.org_id) {
      throw new Error(`session_project_tenant_conflict:${session._id}:${storedProject._id}`)
    }
    const projectId = storedProject?.project_id ?? workspace.project_id
    if (!projectId) throw new Error(`session_project_unresolved:${session._id}`)
    await ctx.db.patch(session._id, {
      org_id: session.org_id ?? workspace.org_id,
      project_id: projectId,
      created_by_user_id: session.created_by_user_id ?? workspace.owner_user_id,
    })
  },
})

// Contract probes are ledger-backed scans rather than an unbounded ad-hoc
// query. A completed status for all five proves every row in that deployment
// satisfies the future required schema before the contract release is pushed.
export const verifyUserActorIdentityContract = migrations.define({
  table: "users",
  migrateOne: (_ctx, user) => {
    if (!user.public_id || !user.kind) throw new Error(`user_identity_incomplete:${user._id}`)
  },
})

export const verifyProjectTenantIdentityContract = migrations.define({
  table: "projects",
  migrateOne: (_ctx, project) => {
    if (
      !project.project_id
      || !project.org_id
      || !project.repo_key
      || !project.owner_user_id
      || project.created_at === undefined
      || project.updated_at === undefined
    ) throw new Error(`project_identity_incomplete:${project._id}`)
  },
})

export const verifyProjectMembershipIdentityContract = migrations.define({
  table: "project_memberships",
  migrateOne: async (ctx, membership) => {
    const project = await projectFromStoredIdentity(ctx, membership.project_id)
    if (!project?.project_id || membership.project_id !== project.project_id) {
      throw new Error(`project_membership_identity_incomplete:${membership._id}`)
    }
  },
})

export const verifyWorkspaceTenantIdentityContract = migrations.define({
  table: "workspaces",
  migrateOne: (_ctx, workspace) => {
    if (!workspace.org_id || !workspace.project_id) {
      throw new Error(`workspace_identity_incomplete:${workspace._id}`)
    }
  },
})

export const verifySessionTenantIdentityContract = migrations.define({
  table: "session_history",
  migrateOne: (_ctx, session) => {
    if (!session.org_id || !session.project_id || !session.created_by_user_id) {
      throw new Error(`session_identity_incomplete:${session._id}`)
    }
  },
})

export async function migrateProjectTenantIdentity(ctx: any, project: any) {
  const projectId = stringValue(project.project_id) ?? stringValue(project.externalId) ?? `prj_legacy_${project._id}`
  const duplicate = await ctx.db
    .query("projects")
    .withIndex("by_project_id", (query: any) => query.eq("project_id", projectId))
    .unique()
  if (duplicate && duplicate._id !== project._id) {
    throw new Error(`project_public_id_duplicate:${project._id}:${duplicate._id}`)
  }
  const organization = project.org_id
    ? await ctx.db.get(project.org_id)
    : await organizationFromLegacyIdentity(ctx, project.organizationId)
      ?? await uniqueUserOrganization(ctx, project.owner_user_id)
  if (!organization) throw new Error(`project_organization_unresolved:${project._id}`)
  const ownerUserId = project.owner_user_id ?? organization.owner_user_id
  if (!ownerUserId) throw new Error(`project_owner_unresolved:${project._id}`)
  const repoKey = canonicalRepoKey({
    repoKey: stringValue(project.repo_key),
    repoUrl: stringValue(project.repoUrl),
    workspaceId: projectId,
  })
  const repoDuplicate = await ctx.db
    .query("projects")
    .withIndex("by_org_repo_key", (query: any) => query.eq("org_id", organization._id).eq("repo_key", repoKey))
    .unique()
  if (repoDuplicate && repoDuplicate._id !== project._id) {
    throw new Error(`project_repo_key_duplicate:${project._id}:${repoDuplicate._id}`)
  }
  const createdAt = project.created_at ?? project.createdAt ?? project._creationTime
  await ctx.db.patch(project._id, {
    project_id: projectId,
    org_id: organization._id,
    repo_key: repoKey,
    owner_user_id: ownerUserId,
    created_at: createdAt,
    updated_at: project.updated_at ?? project.updatedAt ?? createdAt,
  })
}

export async function migrateWorkspaceTenantIdentity(ctx: any, workspace: any) {
  const storedProject = workspace.project_id
    ? await projectFromStoredIdentity(ctx, workspace.project_id)
    : undefined
  if (workspace.project_id && !storedProject) throw new Error(`workspace_project_missing:${workspace._id}`)
  const organization = workspace.org_id
    ? await ctx.db.get(workspace.org_id)
    : storedProject?.org_id
      ? await ctx.db.get(storedProject.org_id)
      : await uniqueUserOrganization(ctx, workspace.owner_user_id)
  if (!organization) throw new Error(`workspace_organization_unresolved:${workspace._id}`)
  if (storedProject?.org_id && storedProject.org_id !== organization._id) {
    throw new Error(`workspace_project_tenant_conflict:${workspace._id}:${storedProject._id}`)
  }
  const repoKey = canonicalRepoKey({
    repoUrl: stringValue(workspace.repo_url) ?? stringValue(workspace.remote_directory),
    workspaceId: workspace.workspace_id,
  })
  const matching = storedProject ?? await ctx.db
    .query("projects")
    .withIndex("by_org_repo_key", (query: any) => query.eq("org_id", organization._id).eq("repo_key", repoKey))
    .unique()
  const project = matching ?? await insertMigratedWorkspaceProject(ctx, workspace, organization._id, repoKey)
  if (!project.project_id) throw new Error(`workspace_project_unresolved:${workspace._id}`)
  await ctx.db.patch(workspace._id, {
    org_id: organization._id,
    project_id: project.project_id,
  })
}

async function insertMigratedWorkspaceProject(ctx: any, workspace: any, organizationId: any, repoKey: string) {
  const projectId = `prj_legacy_${workspace.workspace_id}`
  const existing = await ctx.db
    .query("projects")
    .withIndex("by_project_id", (query: any) => query.eq("project_id", projectId))
    .unique()
  if (existing) {
    if (existing.org_id !== organizationId || existing.repo_key !== repoKey) {
      throw new Error(`workspace_project_identity_conflict:${workspace._id}:${existing._id}`)
    }
    return existing
  }
  const now = workspace.created_at ?? workspace._creationTime
  const id = await ctx.db.insert("projects", {
    project_id: projectId,
    org_id: organizationId,
    repo_key: repoKey,
    owner_user_id: workspace.owner_user_id,
    created_at: now,
    updated_at: workspace.updated_at ?? now,
  })
  return await ctx.db.get(id)
}

async function projectFromStoredIdentity(ctx: any, value: unknown) {
  if (typeof value !== "string") return
  const documentId = ctx.db.normalizeId("projects", value)
  const document = documentId ? await ctx.db.get(documentId) : undefined
  if (document) return document
  return await ctx.db
    .query("projects")
    .withIndex("by_project_id", (query: any) => query.eq("project_id", value))
    .unique()
}

async function organizationFromLegacyIdentity(ctx: any, value: unknown) {
  if (typeof value !== "string") return
  const documentId = ctx.db.normalizeId("orgs", value)
  const document = documentId ? await ctx.db.get(documentId) : undefined
  if (document) return document
  return await ctx.db
    .query("orgs")
    .withIndex("by_clerk_org_id", (query: any) => query.eq("clerk_org_id", value))
    .unique()
}

async function uniqueUserOrganization(ctx: any, userId: unknown) {
  if (!userId) return
  const memberships = await ctx.db
    .query("org_memberships")
    .withIndex("by_user", (query: any) => query.eq("user_id", userId))
    .collect()
  const organizations = (await Promise.all(memberships.map((membership: any) => ctx.db.get(membership.org_id))))
    .filter((organization: any) => organization && !organization.deleted_at)
  if (organizations.length !== 1) return
  return organizations[0]
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const initializeWorkGraphAttention = migrations.define({
  table: "workgraphs",
  migrateOne: async (ctx, row) => {
    if (!row.organization_id) throw new Error("Run WorkGraph tenancy migration before Attention projection migration")
    await initializeAttentionProjection(ctx, String(row.organization_id), String(row.owner_user_id), row.updated_at)
  },
})

export const backfillWorkGraphAdmissionAttention = attentionMigration("workgraph_admission_proposals")
export const backfillWorkGraphDecisionAttention = attentionMigration("workgraph_decisions")
export const backfillWorkGraphWorkItemAttention = attentionMigration("workgraph_work_items")
export const backfillWorkGraphRunAttention = attentionMigration("workgraph_runs")
export const backfillWorkGraphGenerationAttention = attentionMigration("workgraph_due_jobs")

export const backfillWorkGraphCandidateAttention = migrations.define({
  table: "workgraph_intake_candidates",
  migrateOne: backfillCandidateAttention,
})

// Approval-gate rollout COMPLETED 2026-07-18: the supervised/autonomous
// `executionMode` concept was replaced by the durable `pending_approval`
// ("Staged") task state plus a pause/resume launch gate, and the
// one-shot migrations `reconcileStreamLifecycleFromExecutionState`,
// `clearWorkGraphStreamExecutionMode`, `clearWorkGraphRunExecutionMode`,
// plus the recap-removal cleanups `clearWorkGraphRecapFields` /
// `clearWorkGraphStreamRecapFields`, ran to completion (recorded in the
// component ledger) and their definitions were removed alongside the CONTRACT
// schema drop of the legacy execution_mode/execution_state/recap fields.

// WorkGraph tenancy EXPAND -> MIGRATE. Each migration is deliberately
// table-specific in the component ledger. Only organization provenance stored
// on the row itself may assign tenancy. Rows without persisted provenance are
// copied to quarantine and removed from active worker scans for explicit
// operator resolution.
export const scopeWorkGraphsByOrganization = workGraphTenancyMigration("workgraphs")
export const scopeWorkSourcesByOrganization = workGraphTenancyMigration("work_sources")
export const scopeWorkSourceRevisionsByOrganization = workGraphTenancyMigration("work_source_revisions")
export const scopeWorkGraphSourceViewsByOrganization = workGraphTenancyMigration("workgraph_source_views")
export const scopeWorkGraphIntakeCandidatesByOrganization = workGraphTenancyMigration("workgraph_intake_candidates")
export const scopeWorkGraphExternalIdentitiesByOrganization = workGraphTenancyMigration("workgraph_external_identities")
export const scopeWorkGraphStreamsByOrganization = workGraphTenancyMigration("workgraph_streams")
export const scopeWorkGraphOutcomesByOrganization = workGraphTenancyMigration("workgraph_outcomes")
export const scopeWorkGraphWorkItemsByOrganization = workGraphTenancyMigration("workgraph_work_items")
export const scopeWorkGraphDependenciesByOrganization = workGraphTenancyMigration("workgraph_work_item_dependencies")
export const scopeWorkGraphRunsByOrganization = workGraphTenancyMigration("workgraph_runs")
export const scopeWorkGraphConnectionMetadataByOrganization = workGraphTenancyMigration("workgraph_connection_metadata")
export const scopeWorkGraphRunConnectionBindingsByOrganization = workGraphTenancyMigration("workgraph_run_connection_bindings")
export const scopeWorkGraphLeasesByOrganization = workGraphTenancyMigration("workgraph_leases")
export const scopeWorkGraphDecisionsByOrganization = workGraphTenancyMigration("workgraph_decisions")
export const scopeWorkGraphDecisionItemsByOrganization = workGraphTenancyMigration("workgraph_decision_work_items")
export const scopeWorkGraphEvidenceByOrganization = workGraphTenancyMigration("workgraph_evidence")
export const scopeWorkGraphDurableReceiptsByOrganization = workGraphTenancyMigration("workgraph_durable_effect_receipts")
export const scopeWorkGraphAdmissionProposalsByOrganization = workGraphTenancyMigration("workgraph_admission_proposals")
export const scopeWorkGraphAttentionEntriesByOrganization = workGraphTenancyMigration("workgraph_attention_entries")
export const scopeWorkGraphAttentionSummariesByOrganization = workGraphTenancyMigration("workgraph_attention_summaries")
export const scopeWorkGraphOperationResultsByOrganization = workGraphTenancyMigration("workgraph_operation_results")
export const scopeWorkGraphStreamSequencesByOrganization = workGraphTenancyMigration("workgraph_stream_sequences")
export const scopeWorkGraphEventsByOrganization = workGraphTenancyMigration("workgraph_events")
export const scopeWorkGraphChangesByOrganization = workGraphTenancyMigration("workgraph_changes")
export const scopeWorkGraphRecordSourcesByOrganization = workGraphTenancyMigration("workgraph_record_source_revisions")
export const scopeWorkGraphRuntimeEffectsByOrganization = workGraphTenancyMigration("workgraph_runtime_effects")
export const scopeWorkGraphArchiveRestoresByOrganization = workGraphTenancyMigration("workgraph_archive_restores")
export const scopeWorkGraphDeletionBarriersByOrganization = workGraphTenancyMigration("workgraph_owner_deletion_barriers")
export const scopeWorkGraphOutboxByOrganization = workGraphTenancyMigration("workgraph_outbox")
export const scopeWorkGraphDueJobsByOrganization = workGraphTenancyMigration("workgraph_due_jobs")
export const scopeWorkGraphCleanupReceiptsByOrganization = workGraphTenancyMigration("workgraph_cleanup_receipts")
export const scopeWorkGraphMigrationIntakeByOrganization = workGraphTenancyMigration("workgraph_migration_intake")

export async function backfillCandidateAttention(ctx: Parameters<typeof syncCandidateTransition>[0], row: any) {
  if (!row.organization_id) throw new Error("Run WorkGraph tenancy migration before Attention projection migration")
  await initializeAttentionProjection(ctx, String(row.organization_id), String(row.owner_user_id), row.updated_at)
  await syncCandidateTransition(ctx, undefined, row)
}

function attentionMigration(table: "workgraph_admission_proposals" | "workgraph_decisions" | "workgraph_work_items" | "workgraph_runs" | "workgraph_due_jobs") {
  return migrations.define({
    table,
    migrateOne: async (ctx, row) => {
      if (!row.organization_id) throw new Error("Run WorkGraph tenancy migration before Attention projection migration")
      await initializeAttentionProjection(ctx, String(row.organization_id), String(row.owner_user_id), row.updated_at)
      await syncAttentionRecord(ctx, table, row)
    },
  })
}

function workGraphTenancyMigration(table: WorkGraphTenantTable) {
  return migrations.define({
    table,
    migrateOne: (ctx: any, row: any) => migrateWorkGraphTenancyRow(ctx, table, row),
  } as never)
}

export async function migrateWorkGraphTenancyRow(ctx: any, table: WorkGraphTenantTable, row: any) {
  if (row.organization_id) {
    if (row.org_id || (table === "workgraph_connection_metadata" && row.owner_user_id)) {
      await ctx.db.patch(row._id, {
        org_id: undefined,
        ...(table === "workgraph_connection_metadata" ? { owner_user_id: undefined } : {}),
      })
    }
    return
  }
  if (row.org_id) {
    await ctx.db.patch(row._id, {
      organization_id: row.org_id,
      org_id: undefined,
      ...(table === "workgraph_connection_metadata" ? { owner_user_id: undefined } : {}),
    })
    return
  }
  const recordId = String(row._id)
  const memberships = row.owner_user_id
    ? await ctx.db.query("org_memberships")
      .withIndex("by_user", (query: any) => query.eq("user_id", row.owner_user_id))
      .collect()
    : []
  const organizations = [...new Set(memberships.map((membership: any) => membership.org_id))]
  const existing = await ctx.db.query("workgraph_tenancy_migration_quarantine")
    .withIndex("by_record", (query: any) => query.eq("table_name", table).eq("record_id", recordId))
    .unique()
  if (existing) return
  await ctx.db.insert("workgraph_tenancy_migration_quarantine", {
    table_name: table,
    record_id: recordId,
    owner_user_id: row.owner_user_id,
    candidate_organization_ids: organizations,
    reason: organizations.length > 1 ? "ambiguous_organization" : "missing_organization",
    record: row,
    quarantined_at: Date.now(),
  })
  await ctx.db.delete(row._id)
}

type WorkGraphTenantTable =
  | "workgraphs"
  | "work_sources"
  | "work_source_revisions"
  | "workgraph_source_views"
  | "workgraph_intake_candidates"
  | "workgraph_external_identities"
  | "workgraph_streams"
  | "workgraph_outcomes"
  | "workgraph_work_items"
  | "workgraph_work_item_dependencies"
  | "workgraph_runs"
  | "workgraph_connection_metadata"
  | "workgraph_run_connection_bindings"
  | "workgraph_leases"
  | "workgraph_decisions"
  | "workgraph_decision_work_items"
  | "workgraph_evidence"
  | "workgraph_durable_effect_receipts"
  | "workgraph_admission_proposals"
  | "workgraph_attention_entries"
  | "workgraph_attention_summaries"
  | "workgraph_operation_results"
  | "workgraph_stream_sequences"
  | "workgraph_events"
  | "workgraph_changes"
  | "workgraph_record_source_revisions"
  | "workgraph_runtime_effects"
  | "workgraph_archive_restores"
  | "workgraph_owner_deletion_barriers"
  | "workgraph_outbox"
  | "workgraph_due_jobs"
  | "workgraph_cleanup_receipts"
  | "workgraph_migration_intake"
