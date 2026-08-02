import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS } from "@claxedo/workgraph/contracts"
import { attestForService, readForService } from "../../../../convex/workgraphCapabilities"

describe("Convex WorkGraph capability attestations", () => {
  beforeEach(() => vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret"))
  afterEach(() => vi.unstubAllEnvs())

  test("persists the exact catalog revision and expiry and serves it before expiry", async () => {
    const db = fixture()
    const observedAt = 1_000
    const catalog = capabilities(observedAt, "a".repeat(64))
    await invoke(attestForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: observedAt,
    })

    expect(db.rows.workgraph_execution_capabilities).toEqual([expect.objectContaining({
      organization_id: "org_a",
      owner_user_id: "user_a",
      catalog_revision: catalog.catalogRevision,
      observed_at: catalog.observedAt,
      expires_at: catalog.expiresAt,
      catalog,
    })])
    await expect(invoke(readForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      now: catalog.expiresAt - 1,
    })).resolves.toEqual(catalog)
  })

  test("rejects attestation and reads at the exact exclusive expiry boundary", async () => {
    const db = fixture()
    const observedAt = 2_000
    const catalog = capabilities(observedAt, "b".repeat(64))

    await expect(invoke(attestForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: catalog.expiresAt,
    })).rejects.toThrow("Expired execution capabilities cannot be attested")

    await invoke(attestForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: observedAt,
    })
    await expect(invoke(readForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      now: catalog.expiresAt,
    })).rejects.toThrow("attestation has expired")
  })

  test("fails closed for a pre-freshness attestation row", async () => {
    const db = fixture()
    const catalog = capabilities(3_000, "c".repeat(64))
    db.rows.workgraph_execution_capabilities.push({
      _id: "legacy_capabilities",
      organization_id: "org_a",
      owner_user_id: "user_a",
      schema_version: 1,
      observed_at: catalog.observedAt,
      attested_at: catalog.observedAt,
      catalog,
    })

    await expect(invoke(readForService, db, {
      organization_id: "org_a",
      owner_subject: "owner_a",
      now: catalog.expiresAt - 1,
    })).rejects.toThrow("predates the freshness contract")
  })
})

function capabilities(observedAt: number, catalogRevision: string) {
  return {
    schemaVersion: 1 as const,
    organizationId: "org_a",
    ownerUserId: "owner_a",
    catalogRevision,
    observedAt,
    expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
    environments: [{
      kind: "hosted_workspace" as const,
      repositoryRequired: false,
      remoteUrlInput: true,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "opencode" }],
    agents: [{ harnessId: "opencode", id: "build", label: "Build" }],
    models: [],
    tools: [{ harnessId: "opencode", id: "read" }],
    repository: { baseRevisions: [] },
    connections: [],
  }
}

function invoke(fn: unknown, db: MemoryDb, args: Record<string, unknown>) {
  return (fn as { _handler: (context: unknown, args: Record<string, unknown>) => Promise<unknown> })._handler(
    { db },
    { service_token: "service-secret", ...args },
  )
}

function fixture() {
  return new MemoryDb({
    users: [{ _id: "user_a", clerk_subject: "owner_a" }],
    orgs: [{ _id: "org_a", name: "A" }],
    org_memberships: [{ _id: "membership_a", org_id: "org_a", user_id: "user_a", role: "owner" }],
    workgraph_execution_capabilities: [],
  })
}

class MemoryDb {
  private next = 0

  constructor(readonly rows: Record<string, Array<Record<string, unknown>>>) {}

  query(table: string) {
    let selected = [...(this.rows[table] ?? [])]
    const chain = {
      withIndex: (_name: string, build: (query: Record<string, unknown>) => unknown) => {
        const predicates: Array<(row: Record<string, unknown>) => boolean> = []
        const query = {
          eq: (field: string, value: unknown) => {
            predicates.push((row: Record<string, unknown>) => row[field] === value)
            return query
          },
        }
        build(query)
        selected = selected.filter((row) => predicates.every((predicate) => predicate(row)))
        return chain
      },
      filter: (build: (query: Record<string, unknown>) => unknown) => {
        const query = {
          field: (field: string) => field,
          eq: (field: string, value: unknown) => (row: Record<string, unknown>) => row[field] === value,
        }
        const predicate = build(query)
        if (typeof predicate === "function") selected = selected.filter(predicate as (row: Record<string, unknown>) => boolean)
        return chain
      },
      unique: async () => selected[0] ?? null,
    }
    return chain
  }

  async get(id: string) {
    return Object.values(this.rows).flat().find((row) => row._id === id) ?? null
  }

  async insert(table: string, value: Record<string, unknown>) {
    const id = `${table}_${++this.next}`
    ;(this.rows[table] ??= []).push({ _id: id, ...value })
    return id
  }

  async patch(id: string, value: Record<string, unknown>) {
    const row = await this.get(id)
    if (!row) throw new Error(`Missing row ${id}`)
    Object.assign(row, value)
  }
}
