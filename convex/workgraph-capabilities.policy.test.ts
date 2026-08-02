import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest } from "convex-test"
import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS } from "@claxedo/workgraph/contracts"
import { api } from "./_generated/api"
import schema from "./schema"

declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>
  }
}

const modules = import.meta.glob("./**/*.ts")

const stamped = <T extends Record<string, unknown>>(row: T) => ({ created_at: 1, updated_at: 1, ...row })

/**
 * WorkGraph execution-capability attestation policy: freshness at write time,
 * the exclusive expiry boundary, and fail-closed on legacy rows that predate
 * the freshness contract. These are `serviceMutation`/`serviceQuery` — the
 * control-plane executor calling convention (`service_token` + trusted
 * owner-subject resolution via `requireTrustedWorkGraphTenantSubject`).
 *
 * The previous version of this suite drove a hand-written `MemoryDb` and
 * reached past the builders into `_handler`, so it never exercised
 * `requireControlPlaneService`/`requireTrustedWorkGraphTenantSubject` at all
 * and used fabricated string ids ("org_a") that the real schema's `v.id("orgs")`
 * would never accept.
 */
describe("Convex WorkGraph capability attestations", () => {
  beforeEach(() => vi.stubEnv("CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN", "service-secret"))
  afterEach(() => vi.unstubAllEnvs())

  async function fixture(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const orgId = await ctx.db.insert("orgs", stamped({ name: "A" }) as never)
      const userId = await ctx.db.insert("users", stamped({ token_identifier: "clerk|owner_a", clerk_subject: "owner_a" }) as never)
      await ctx.db.insert("org_memberships", stamped({ org_id: orgId, user_id: userId, role: "owner" }) as never)
      return { orgId, userId }
    })
  }

  function capabilities(orgId: string, observedAt: number, catalogRevision: string) {
    return {
      schemaVersion: 1 as const,
      organizationId: orgId,
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

  test("persists the exact catalog revision and expiry and serves it before expiry", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await fixture(t)
    const observedAt = 1_000
    const catalog = capabilities(orgId, observedAt, "a".repeat(64))

    await t.mutation(api.workgraphCapabilities.attestForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: observedAt,
    } as never)

    const rows = await t.run(async (ctx) => ctx.db.query("workgraph_execution_capabilities").collect())
    expect(rows).toEqual([expect.objectContaining({
      organization_id: orgId,
      owner_user_id: expect.any(String),
      catalog_revision: catalog.catalogRevision,
      observed_at: catalog.observedAt,
      expires_at: catalog.expiresAt,
      catalog,
    })])

    await expect(t.query(api.workgraphCapabilities.readForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      now: catalog.expiresAt - 1,
    } as never)).resolves.toEqual(catalog)
  })

  test("rejects attestation and reads at the exact exclusive expiry boundary", async () => {
    const t = convexTest(schema, modules)
    const { orgId } = await fixture(t)
    const observedAt = 2_000
    const catalog = capabilities(orgId, observedAt, "b".repeat(64))

    await expect(t.mutation(api.workgraphCapabilities.attestForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: catalog.expiresAt,
    } as never)).rejects.toThrow("Expired execution capabilities cannot be attested")

    await t.mutation(api.workgraphCapabilities.attestForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      capabilities: catalog,
      attested_at: observedAt,
    } as never)

    await expect(t.query(api.workgraphCapabilities.readForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      now: catalog.expiresAt,
    } as never)).rejects.toThrow("attestation has expired")
  })

  test("fails closed for a pre-freshness attestation row", async () => {
    const t = convexTest(schema, modules)
    const { orgId, userId } = await fixture(t)
    const catalog = capabilities(orgId, 3_000, "c".repeat(64))

    await t.run(async (ctx) => {
      await ctx.db.insert("workgraph_execution_capabilities", {
        organization_id: orgId,
        owner_user_id: userId,
        schema_version: 1,
        observed_at: catalog.observedAt,
        attested_at: catalog.observedAt,
        catalog,
      } as never)
    })

    await expect(t.query(api.workgraphCapabilities.readForService, {
      service_token: "service-secret",
      organization_id: orgId,
      owner_subject: "owner_a",
      now: catalog.expiresAt - 1,
    } as never)).rejects.toThrow("predates the freshness contract")
  })
})
