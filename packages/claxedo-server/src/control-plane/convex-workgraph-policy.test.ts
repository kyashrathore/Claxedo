import { afterEach, describe, expect, test, vi } from "vitest"
import schema from "../../../../convex/schema"
import {
  requireOwnedWorkGraphContext,
  requireTrustedWorkGraphOwner,
  requireTrustedWorkGraphOwnerSubject,
} from "../../../../convex/workgraphModel"

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
  "workgraph_attempts",
  "workgraph_connection_metadata",
  "workgraph_attempt_connection_bindings",
  "workgraph_leases",
  "workgraph_decisions",
  "workgraph_decision_work_items",
  "workgraph_evidence",
  "workgraph_durable_effect_receipts",
  "workgraph_recaps",
  "workgraph_admission_proposals",
  "workgraph_operation_results",
  "workgraph_stream_sequences",
  "workgraph_change_cursors",
  "workgraph_events",
  "workgraph_changes",
  "workgraph_outbox",
  "workgraph_due_jobs",
  "workgraph_cleanup_receipts",
  "workgraph_migration_intake",
] as const

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Convex WorkGraph persistence policy", () => {
  test("defines the complete owner-first cloud persistence vocabulary", () => {
    for (const tableName of workGraphTables) {
      const table = schema.tables[tableName]
      expect(table, tableName).toBeDefined()
      expect(table.validator.fields.owner_user_id).toMatchObject({
        isOptional: "required",
        kind: "id",
        tableName: "users",
      })
      const indexes = (table as unknown as { indexes: Array<{ fields: string[] }> }).indexes
      expect(
        indexes.some((index) => index.fields[0] === "owner_user_id"),
        tableName,
      ).toBe(true)
    }
  })

  test("keeps exact multi-source provenance and optional Outcome placement in public records", () => {
    for (const tableName of [
      "workgraph_streams",
      "workgraph_outcomes",
      "workgraph_work_items",
      "workgraph_attempts",
      "workgraph_decisions",
      "workgraph_recaps",
    ] as const) {
      expect(schema.tables[tableName].validator.fields.source_revision_refs).toMatchObject({
        isOptional: "required",
        kind: "array",
      })
    }
    expect(schema.tables.workgraph_work_items.validator.fields.outcome_id.isOptional).toBe("optional")
    expect(
      (schema.tables.workgraph_attempts as unknown as { indexes: Array<{ fields: string[] }> }).indexes,
    ).toContainEqual(expect.objectContaining({ fields: ["state", "updated_at"] }))
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
