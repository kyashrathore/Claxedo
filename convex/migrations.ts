// D14 — Convex schema evolution discipline (launch plan 2026-07-11-012 §1 /
// ADR 016 §5): expand-migrate-contract is law, and the MIGRATE step runs
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

// #001 — retro-registration of the hand-rolled `sandboxLeases.normalizeLegacyFields`
// backfill (provider-era field names → driver/driver_resource_id rename on
// runtime_leases). The legacy fields are already gone from convex/schema.ts,
// so on a schema-validated deployment this is a no-op sweep; it exists so the
// component ledger — not operator memory — records that the backfill is
// complete on each deployment before any future contract step.
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
    await initializeAttentionProjection(ctx, String(row.owner_user_id), row.updated_at)
  },
})

export const backfillWorkGraphAdmissionAttention = attentionMigration("workgraph_admission_proposals")
export const backfillWorkGraphDecisionAttention = attentionMigration("workgraph_decisions")
export const backfillWorkGraphWorkItemAttention = attentionMigration("workgraph_work_items")
export const backfillWorkGraphAttemptAttention = attentionMigration("workgraph_attempts")
export const backfillWorkGraphNotificationAttention = attentionMigration("workgraph_notifications")
export const backfillWorkGraphConnectionAttention = attentionMigration("workgraph_connection_metadata")
export const backfillWorkGraphGenerationAttention = attentionMigration("workgraph_due_jobs")

export const backfillWorkGraphCandidateAttention = migrations.define({
  table: "workgraph_intake_candidates",
  migrateOne: backfillCandidateAttention,
})

export async function backfillCandidateAttention(ctx: Parameters<typeof syncCandidateTransition>[0], row: any) {
  await initializeAttentionProjection(ctx, String(row.owner_user_id), row.updated_at)
  await syncCandidateTransition(ctx, undefined, row)
}

function attentionMigration(table: "workgraph_admission_proposals" | "workgraph_decisions" | "workgraph_work_items" | "workgraph_attempts" | "workgraph_notifications" | "workgraph_connection_metadata" | "workgraph_due_jobs") {
  return migrations.define({
    table,
    migrateOne: async (ctx, row) => {
      await initializeAttentionProjection(ctx, String(row.owner_user_id), row.updated_at)
      await syncAttentionRecord(ctx, table, row)
    },
  })
}
