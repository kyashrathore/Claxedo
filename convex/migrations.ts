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
import { initializeAttentionProjection, syncAttentionRecord, syncCandidateTransition } from "./workgraphAttention"

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
export const backfillWorkGraphAttemptAttention = attentionMigration("workgraph_attempts")
export const backfillWorkGraphGenerationAttention = attentionMigration("workgraph_due_jobs")

export const backfillWorkGraphCandidateAttention = migrations.define({
  table: "workgraph_intake_candidates",
  migrateOne: backfillCandidateAttention,
})

// Approval-gate rollout COMPLETED 2026-07-18: the supervised/autonomous
// `executionMode` concept was replaced by the durable `pending_approval`
// ("Staged") task state plus a pause/resume launch gate, and the
// one-shot migrations `reconcileStreamLifecycleFromExecutionState`,
// `clearWorkGraphStreamExecutionMode`, `clearWorkGraphAttemptExecutionMode`,
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
export const scopeWorkGraphAttemptsByOrganization = workGraphTenancyMigration("workgraph_attempts")
export const scopeWorkGraphConnectionMetadataByOrganization = workGraphTenancyMigration("workgraph_connection_metadata")
export const scopeWorkGraphAttemptConnectionBindingsByOrganization = workGraphTenancyMigration("workgraph_attempt_connection_bindings")
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
export const scopeWorkGraphChangeCursorsByOrganization = workGraphTenancyMigration("workgraph_change_cursors")
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

function attentionMigration(table: "workgraph_admission_proposals" | "workgraph_decisions" | "workgraph_work_items" | "workgraph_attempts" | "workgraph_due_jobs") {
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
  | "workgraph_attempts"
  | "workgraph_connection_metadata"
  | "workgraph_attempt_connection_bindings"
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
  | "workgraph_change_cursors"
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
