import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"

import { createD1McpOAuthClientRegistry, type McpOAuthClientSecretStore } from "./d1-client-registry"

// 0021 owns the table under test and depends on nothing else — the real
// migration file runs, so a schema this test invented could not pass while the
// shipped one fails.
const MIGRATIONS = ["0021_mcp_oauth_clients.sql"]

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function database(): Promise<D1Database> {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const target = await instance.getD1Database("CONTROL_PLANE_DB")
  for (const name of MIGRATIONS) {
    const path = fileURLToPath(new URL(`../../../migrations/control-plane/${name}`, import.meta.url))
    const migration = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await target.prepare(statement).run()
    }
  }
  return target
}

/** Stands in for the envelope-encrypted deployment credential partition. */
function secretStore(): McpOAuthClientSecretStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>()
  return {
    rows,
    put: async (providerId, secret) => void rows.set(providerId, secret),
    get: async (providerId) => rows.get(providerId),
  }
}

const rows = (target: D1Database) =>
  target
    .prepare("select issuer, client_id, client_secret_ref, registration_json, registered_at from mcp_oauth_clients")
    .all<Record<string, unknown>>()

describe("D1 MCP OAuth client registry", () => {
  test("registers a public client once and answers every later lookup from the row", async () => {
    const target = await database()
    const registry = createD1McpOAuthClientRegistry({ database: target, now: () => 1_700_000_000_000 })

    expect(await registry.lookup("https://clerk.context7.test")).toBeUndefined()

    const registered = await registry.register({
      issuer: "https://clerk.context7.test",
      registrationEndpoint: "https://clerk.context7.test/oauth/register",
      metadata: {
        client_id: "dyn-context7",
        client_id_issued_at: 1,
        token_endpoint_auth_method: "none",
        redirect_uris: ["https://claxedo.test/api/claxedo/integrations/callback"],
      },
    })
    expect(registered).toEqual({ clientId: "dyn-context7" })
    expect(await registry.lookup("https://clerk.context7.test")).toEqual({ clientId: "dyn-context7" })

    // A second registry instance stands in for the next request's isolate:
    // this is durability, not process memory.
    const next = createD1McpOAuthClientRegistry({ database: target })
    expect(await next.lookup("https://clerk.context7.test")).toEqual({ clientId: "dyn-context7" })

    const stored = await rows(target)
    expect(stored.results).toEqual([{
      issuer: "https://clerk.context7.test",
      client_id: "dyn-context7",
      client_secret_ref: null,
      registration_json: JSON.stringify({
        client_id: "dyn-context7",
        client_id_issued_at: 1,
        token_endpoint_auth_method: "none",
        redirect_uris: ["https://claxedo.test/api/claxedo/integrations/callback"],
        registration_endpoint: "https://clerk.context7.test/oauth/register",
      }),
      registered_at: 1_700_000_000_000,
    }])
  })

  test("an issued client secret reaches the credential store and never D1", async () => {
    const target = await database()
    const secrets = secretStore()
    const registry = createD1McpOAuthClientRegistry({ database: target, secrets })

    const registered = await registry.register({
      issuer: "https://login.example.test",
      registrationEndpoint: "https://login.example.test/register",
      metadata: {
        client_id: "dyn-secret",
        client_secret: "super-secret-value",
        registration_access_token: "rat-value",
      },
    })
    expect(registered).toEqual({ clientId: "dyn-secret", clientSecret: "super-secret-value" })
    expect(await registry.lookup("https://login.example.test")).toEqual({
      clientId: "dyn-secret",
      clientSecret: "super-secret-value",
    })

    const stored = await rows(target)
    expect(JSON.stringify(stored.results)).not.toContain("super-secret-value")
    expect(JSON.stringify(stored.results)).not.toContain("rat-value")
    // The row keeps only an opaque reference the credential store resolves.
    const ref = stored.results[0]?.client_secret_ref as string
    expect(ref).toMatch(/^mcp-oauth-client:/)
    expect(secrets.rows.get(ref)).toBe("super-secret-value")
    // Every dump of the whole registry table is safe to read.
    expect(ref).not.toContain("super-secret-value")
  })

  test("concurrent registrations converge on one client and the loser reads the winner", async () => {
    const target = await database()
    const registry = createD1McpOAuthClientRegistry({ database: target })

    const [first, second] = await Promise.all([
      registry.register({
        issuer: "https://login.example.test",
        registrationEndpoint: "https://login.example.test/register",
        metadata: { client_id: "client-a" },
      }),
      registry.register({
        issuer: "https://login.example.test",
        registrationEndpoint: "https://login.example.test/register",
        metadata: { client_id: "client-b" },
      }),
    ])

    expect(first).toEqual(second)
    expect(["client-a", "client-b"]).toContain(first.clientId)
    const stored = await rows(target)
    expect(stored.results).toHaveLength(1)
    expect(await registry.lookup("https://login.example.test")).toEqual(first)
  })

  test("refuses to hold a secret when no credential store is composed", async () => {
    const target = await database()
    const registry = createD1McpOAuthClientRegistry({ database: target })

    await expect(registry.register({
      issuer: "https://login.example.test",
      registrationEndpoint: "https://login.example.test/register",
      metadata: { client_id: "dyn", client_secret: "leaked" },
    })).rejects.toThrow("no credential store is composed")

    expect((await rows(target)).results).toEqual([])
  })

  test("refuses a registration response with no client id", async () => {
    const target = await database()
    const registry = createD1McpOAuthClientRegistry({ database: target })

    await expect(registry.register({
      issuer: "https://login.example.test",
      registrationEndpoint: "https://login.example.test/register",
      metadata: { error: "invalid_client_metadata" },
    })).rejects.toThrow("carries no client_id")
  })
})
