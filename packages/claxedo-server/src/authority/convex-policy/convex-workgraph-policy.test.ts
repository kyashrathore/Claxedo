import { afterEach, describe, expect, test, vi } from "vitest"
import { readFile } from "node:fs/promises"
import schema from "../../../../../convex/schema"
import {
  requireOwnedWorkGraphContext,
  requireTrustedWorkGraphOwner,
  requireTrustedWorkGraphOwnerSubject,
} from "../../../../../convex/workgraphModel"
import { migrateWorkGraphTenancyRow } from "../../../../../convex/migrations"

const workGraphTables = [
  "workgraphs",
  "work_sources",
  "work_source_revisions",
  "workgraph_source_views",
  "workgraph_intake_candidates",
  "workgraph_external_identities",
  "workgraph_streams",
  "workgraph_outcomes",
  "workgraph_work_items",
  "workgraph_work_item_dependencies",
  "workgraph_runs",
  "workgraph_run_connection_bindings",
  "workgraph_leases",
  "workgraph_decisions",
  "workgraph_decision_work_items",
  "workgraph_evidence",
  "workgraph_durable_effect_receipts",
  "workgraph_admission_proposals",
  "workgraph_attention_entries",
  "workgraph_attention_summaries",
  "workgraph_operation_results",
  "workgraph_stream_sequences",
  "workgraph_events",
  "workgraph_changes",
  "workgraph_record_source_revisions",
  "workgraph_runtime_effects",
  "workgraph_archive_restores",
  "workgraph_owner_deletion_barriers",
  "workgraph_outbox",
  "workgraph_due_jobs",
  "workgraph_cleanup_receipts",
  "workgraph_migration_intake",
  "workgraph_execution_capabilities",
] as const

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Convex WorkGraph persistence policy", () => {
  test("defines the complete organization-and-owner cloud persistence vocabulary", () => {
    for (const tableName of workGraphTables) {
      const table = schema.tables[tableName]
      expect(table, tableName).toBeDefined()
      expect(table.validator.fields.owner_user_id).toMatchObject({
        isOptional: "required",
        kind: "id",
        tableName: "users",
      })
      const indexes = (table as unknown as { indexes: Array<{ fields: string[] }> }).indexes
      const tenantIndexes = tableName === "workgraph_outbox"
        ? indexes.filter((index) => index.fields[0] !== "status")
        : indexes
      expect(
        tenantIndexes.length > 0 &&
          tenantIndexes.every(
            (index) => index.fields[0] === "organization_id" && index.fields[1] === "owner_user_id",
          ),
        tableName,
      ).toBe(true)
    }
    expect(
      (schema.tables.workgraph_outbox as unknown as { indexes: Array<{ fields: string[] }> }).indexes,
    ).toContainEqual(expect.objectContaining({ fields: ["status", "available_at"] }))
    expect(schema.tables.workgraph_connection_metadata.validator.fields.organization_id).toMatchObject({
      isOptional: "required",
      kind: "id",
      tableName: "orgs",
    })
    expect(schema.tables.workgraph_connection_metadata.validator.fields).not.toHaveProperty("owner_user_id")
  })

  test("keeps exact multi-source provenance and optional Outcome placement in public records", () => {
    for (const tableName of [
      "workgraph_streams",
      "workgraph_outcomes",
      "workgraph_work_items",
      "workgraph_runs",
      "workgraph_decisions",
    ] as const) {
      expect(schema.tables[tableName].validator.fields.source_revision_refs).toMatchObject({
        isOptional: "required",
        kind: "array",
      })
    }
    expect(schema.tables.workgraph_work_items.validator.fields.outcome_id.isOptional).toBe("optional")
    const activityGranularity = schema.tables.workgraph_streams.validator.fields.activity_granularity
    expect(activityGranularity).toMatchObject({ isOptional: "optional", kind: "union" })
    expect(activityGranularity.members.map((member) => member.value)).toEqual(["milestones", "progress", "detailed"])
    expect(
      (schema.tables.workgraph_runs as unknown as { indexes: Array<{ fields: string[] }> }).indexes,
    ).toContainEqual(expect.objectContaining({ fields: ["organization_id", "owner_user_id", "state", "updated_at"] }))
  })

  test("keeps tenant work on tuple-leading indexes and bounds the explicit global dispatch scan", async () => {
    const sources = await Promise.all(
      [
        "workgraphArchive.ts",
        "workgraphAttention.ts",
        "workgraphBackground.ts",
        "workgraphCapabilities.ts",
        "workgraphChanges.ts",
        "workgraphCommands.ts",
        "workgraphIntake.ts",
        "workgraphRuntime.ts",
      ].map((file) => readFile(new URL(`../../../../../convex/${file}`, import.meta.url), "utf8")),
    )
    const runtime = sources.join("\n")

    expect(runtime).not.toMatch(/\.query\("(?:workgraph|work_|work_sources)[^\n]*"\)\s*\.filter/)
    expect(runtime).not.toMatch(/withIndex\("by_owner/)
    expect(runtime).not.toMatch(/withIndex\("by_(?:execution_state_updated|state_updated)/)
    const staleTenants = runtime.slice(
      runtime.indexOf("export const listStaleTenants"),
      runtime.indexOf("export const claimLaunches"),
    )
    expect(staleTenants).toContain('withIndex("by_status_available"')
    expect(staleTenants).toContain('withIndex("by_status_claim_expiry"')
    expect(staleTenants).toContain(".take(rowScanLimit)")
    expect(staleTenants).toContain("rowScanLimit - pending.length")
    expect(staleTenants).toContain('lte("claim_expires_at", args.now)')
    for (const worker of [
      "claimLaunches",
      "claimControlEffects",
      "listRunning",
      "drainSessionIntake",
      "claimSourcePlans",
      "listRunningSourcePlans",
    ]) {
      const start = runtime.indexOf(`export const ${worker}`)
      const end = runtime.indexOf("export const ", start + 13)
      expect(runtime.slice(start, end === -1 ? undefined : end)).toMatch(
        /args:\s*\{\s*organization_id: v\.id\("orgs"\),\s*owner_user_id: v\.id\("users"\)/,
      )
    }
  })

  test("indexes every Stream-owned table used by durable deletion", () => {
    for (const tableName of [
      "workgraph_work_item_dependencies",
      "workgraph_decision_work_items",
      "workgraph_evidence",
      "workgraph_durable_effect_receipts",
      "workgraph_runs",
      "workgraph_decisions",
      "workgraph_outcomes",
      "workgraph_leases",
      "workgraph_outbox",
      "workgraph_due_jobs",
      "workgraph_agent_checkpoints",
      "workgraph_session_bindings",
      "workgraph_work_items",
    ] as const) {
      expect((schema.tables[tableName] as unknown as { indexes: Array<{ fields: string[] }> }).indexes, tableName).toContainEqual(
        expect.objectContaining({ fields: ["organization_id", "owner_user_id", "stream_id"] }),
      )
    }
  })

  test("does not place provider credentials in personal WorkGraph documents", () => {
    for (const tableName of workGraphTables) {
      const fields = Object.keys(schema.tables[tableName].validator.fields)
      expect(
        fields.filter((field) => /credential|secret|access_token|refresh_token|api_key/i.test(field)),
        tableName,
      ).toEqual([])
    }
    expect(Object.keys(schema.tables.workgraph_source_views.validator.fields)).toEqual(
      expect.arrayContaining(["team_connection_id", "provider_user_id", "filters"]),
    )
  })

  test("never infers tenancy from current membership and removes unscoped rows from active storage", async () => {
    const rows = {
      org_memberships: [{ _id: "membership", org_id: "org_only", user_id: "owner" }],
      workgraph_tenancy_migration_quarantine: [] as Record<string, unknown>[],
    }
    const deleted: string[] = []
    const ctx = {
      db: {
        query: (table: keyof typeof rows) => {
          let selected = [...rows[table]] as Record<string, unknown>[]
          const chain = {
            withIndex: (_index: string, build: (query: any) => unknown) => {
              const filters: Array<[string, unknown]> = []
              const query = {
                eq: (field: string, value: unknown) => {
                  filters.push([field, value])
                  return query
                },
              }
              build(query)
              selected = selected.filter((row) => filters.every(([field, value]) => row[field] === value))
              return chain
            },
            collect: async () => selected,
            unique: async () => selected[0] ?? null,
          }
          return chain
        },
        insert: async (_table: string, value: Record<string, unknown>) => {
          rows.workgraph_tenancy_migration_quarantine.push(value)
        },
        delete: async (id: string) => {
          deleted.push(id)
        },
        patch: async () => {
          throw new Error("Membership inference attempted to assign organization_id")
        },
      },
    }
    const row = { _id: "legacy_stream", owner_user_id: "owner", id: "stream" }

    await migrateWorkGraphTenancyRow(ctx, "workgraph_streams", row)

    expect(deleted).toEqual(["legacy_stream"])
    expect(rows.workgraph_tenancy_migration_quarantine).toEqual([
      expect.objectContaining({
        record_id: "legacy_stream",
        candidate_organization_ids: ["org_only"],
        reason: "missing_organization",
        record: row,
      }),
    ])
  })

  test("leaves production-shaped pre-WorkGraph rows compatible", () => {
    expect(schema.tables.users.validator.fields).toMatchObject({
      token_identifier: { isOptional: "required", kind: "string" },
      clerk_subject: { isOptional: "optional", kind: "string" },
      kind: { isOptional: "optional", kind: "union" },
      created_at: { isOptional: "required", kind: "float64" },
      updated_at: { isOptional: "required", kind: "float64" },
    })
    expect(schema.tables.projects.validator.fields).toMatchObject({
      externalId: { isOptional: "optional", kind: "string" },
      organizationId: { isOptional: "optional", kind: "string" },
      createdAt: { isOptional: "optional", kind: "float64" },
      updatedAt: { isOptional: "optional", kind: "float64" },
    })
  })

  test("interactive owner context derives its scope without accepting owner selection", async () => {
    const context = {
      auth: { getUserIdentity: async () => ({ tokenIdentifier: "token:user-1" }) },
      db: {
        query: () => ({
          withIndex: (
            _index: string,
            build: (query: { eq: (field: string, value: unknown) => unknown }) => unknown,
          ) => {
            build({ eq: () => undefined })
            return { unique: async () => ({ _id: "user-1" }) }
          },
        }),
      },
    }

    expect(requireOwnedWorkGraphContext.length).toBe(1)
    await expect(requireOwnedWorkGraphContext(context as never)).resolves.toEqual({
      owner_user_id: "user-1",
      user: { _id: "user-1" },
    })
  })

  test("trusted worker owner scope is gated by the existing fail-closed service token boundary", () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")

    expect(requireTrustedWorkGraphOwner("service-secret", "user-1")).toBe("user-1")
    expect(() => requireTrustedWorkGraphOwner("wrong", "user-1")).toThrow("Unauthenticated")
    expect(() => requireTrustedWorkGraphOwner("service-secret", "  ")).toThrow("Invalid WorkGraph owner")
  })

  test("trusted worker resolves a Clerk subject to the internal durable owner id", async () => {
    vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret")
    const context = {
      db: {
        query: () => ({
          withIndex: (_name: string, build: (query: any) => unknown) => {
            let subject = ""
            const query = {
              eq: (_field: string, value: string) => {
                subject = value
                return query
              },
            }
            build(query)
            return {
              unique: async () =>
                subject === "clerk-user-a" ? { _id: "convex-user-internal-a", clerk_subject: subject } : null,
            }
          },
        }),
      },
    }
    await expect(
      requireTrustedWorkGraphOwnerSubject(context as never, "service-secret", "clerk-user-a"),
    ).resolves.toMatchObject({ _id: "convex-user-internal-a" })
    await expect(
      requireTrustedWorkGraphOwnerSubject(context as never, "service-secret", "clerk-user-b"),
    ).rejects.toThrow("WorkGraph owner not found")
  })
})
