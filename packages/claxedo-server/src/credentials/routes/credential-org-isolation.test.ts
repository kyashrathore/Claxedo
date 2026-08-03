/**
 * Cross-tenant isolation for provider credentials on the SELF-HOST path.
 *
 * Provider credentials are model-provider API keys and OAuth tokens — the
 * highest-value secret in the product. Before org scoping landed,
 * `claxedo_provider_credential` had no tenant column, so on a self-hosted box
 * running signed multi-org auth ANY signed-in user could list, read, overwrite,
 * delete, or force-verify ANY other org's credentials. Every test below fails
 * against that shape; all five verbs are covered because all five were
 * reachable.
 *
 * These run against the REAL registry, the REAL SQLite schema, and the REAL
 * per-request org resolution (a stub token verifier stands in for Clerk) —
 * a fake credentials port would prove nothing about the storage predicate.
 */

import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import type { ClerkVerifier, ControlPlaneAuthConfig } from "../../platform/auth/auth"

const root = path.join(realpathSync(os.tmpdir()), `credential-org-isolation-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previousDataDir = process.env.CLAXEDO_DATA_DIR
const previousSignedAuth = process.env.CLAXEDO_SIGNED_CLOUD_AUTH
process.env.CLAXEDO_DATA_DIR = root
// The single-tenant assertions must not accidentally pick up a signed config
// from the ambient environment.
delete process.env.CLAXEDO_SIGNED_CLOUD_AUTH

const { createTestBackend, setBackendOverride } = await import("../store")
const registry = await import("../registry")
const { defaultControlPlaneCredentials } = await import("../../authority/services")
const { CredentialRoutes } = await import("./credential")
const { ClaxedoDB } = await import("../../platform/db/db")
const { SINGLE_TENANT_ORG } = await import("../provider-credential.sql")

const ORG_A = "org_a"
const ORG_B = "org_b"
const ISSUER = "https://isolation.test"

/**
 * Stand-in for Clerk. The bearer IS the org id, except `personal_*` bearers,
 * which carry no `org_id` claim — the case that must fall back to the subject
 * rather than to a shared partition.
 */
const verifier: ClerkVerifier = async (token) => ({
  mode: "signed",
  user: {
    subject: token.startsWith("personal_") ? token : `user_of_${token}`,
    tokenIdentifier: token,
    issuer: ISSUER,
    ...(token.startsWith("personal_") ? {} : { orgId: token }),
  },
})

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: ISSUER,
  jwksUrl: `${ISSUER}/jwks`,
}

const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
  Response.json({ id: "response_1" }))

function as(bearer: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${bearer}` } }
}

const signedApp = CredentialRoutes(defaultControlPlaneCredentials(), {
  authConfig: signedConfig,
  verifier,
  fetch: providerFetch as unknown as typeof fetch,
  now: () => 5_000,
})

/**
 * The same router with signed auth DISABLED — an ordinary self-host box. It
 * must keep working on the named single-tenant partition.
 */
const singleTenantApp = CredentialRoutes(defaultControlPlaneCredentials(), {
  authConfig: { enabled: false, mode: "local-only", reason: "signed/cloud auth is disabled" },
  fetch: providerFetch as unknown as typeof fetch,
  now: () => 5_000,
})

type Listed = { credentials: Array<{ id: string; provider_id: string }> }

async function listAs(bearer: string) {
  const response = await signedApp.request("http://localhost/", as(bearer))
  return (await response.json()) as Listed
}

let credA: { id: string }

// FILE-scope hooks, deliberately NOT inside a `describe`. A per-describe
// `afterAll` restores CLAXEDO_DATA_DIR and clears the secret-backend override
// as soon as the FIRST describe finishes, so every later test in the file would
// run against the developer's real ~/.claxedo database and real encrypted
// secret store — writing, upserting and deleting live credentials.
beforeAll(async () => {
  setBackendOverride(createTestBackend())
  const stored = await signedApp.request("http://localhost/", as(ORG_A, {
    method: "PUT",
    body: JSON.stringify({ provider_id: "openai", kind: "api_key", secret: "sk-org-a-secret" }),
  }))
  credA = ((await stored.json()) as { credential: { id: string } }).credential
  expect(credA.id).toBeTruthy()
})

afterAll(async () => {
  setBackendOverride(undefined)
  ClaxedoDB.close()
  await fs.rm(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  if (previousSignedAuth !== undefined) process.env.CLAXEDO_SIGNED_CLOUD_AUTH = previousSignedAuth
})

describe("provider credential org isolation (self-host, signed multi-org)", () => {
  test("the suite is pinned to its temp data dir, never the developer's real store", () => {
    expect(process.env.CLAXEDO_DATA_DIR).toBe(root)
    expect(ClaxedoDB.Path().startsWith(root)).toBe(true)
  })

  test("a write is stamped with the writer's org, not left tenant-less", () => {
    expect(registry.getCredential(credA.id, ORG_A)?.org_id).toBe(ORG_A)
    expect(registry.getCredential(credA.id, ORG_B)).toBeUndefined()
    expect(registry.getCredential(credA.id, SINGLE_TENANT_ORG)).toBeUndefined()
  })

  // Verb 1 of 5: LIST.
  test("org B cannot list org A's credentials", async () => {
    expect((await listAs(ORG_A)).credentials.map((item) => item.id)).toContain(credA.id)
    expect((await listAs(ORG_B)).credentials.map((item) => item.id)).not.toContain(credA.id)
  })

  // Verb 2 of 5: READ.
  test("org B cannot read org A's credential by provider id", async () => {
    const mine = await signedApp.request("http://localhost/openai", as(ORG_A))
    const theirs = await signedApp.request("http://localhost/openai", as(ORG_B))

    await expect(mine.json()).resolves.toMatchObject({ credential: { id: credA.id, provider_id: "openai" } })
    await expect(theirs.json()).resolves.toEqual({ credential: null })
  })

  // Verb 3a of 5: OVERWRITE via upsert. The pre-fix upsert matched on
  // (provider_id, kind) alone, so this request adopted org A's row, replaced
  // its backend secret, and destroyed the old one.
  test("org B storing the same provider does not overwrite or destroy org A's credential", async () => {
    const stored = await signedApp.request("http://localhost/", as(ORG_B, {
      method: "PUT",
      body: JSON.stringify({ provider_id: "openai", kind: "api_key", secret: "sk-org-b-secret" }),
    }))
    const credB = ((await stored.json()) as { credential: { id: string } }).credential

    expect(credB.id).not.toBe(credA.id)
    await expect(registry.resolveSecretById(credA.id, ORG_A)).resolves.toBe("sk-org-a-secret")
    await expect(registry.resolveSecretById(credB.id, ORG_B)).resolves.toBe("sk-org-b-secret")
    expect(registry.getCredential(credA.id, ORG_A)?.status).toBe("available")
  })

  // Verb 3b of 5: OVERWRITE via status patch (revoke another tenant's key).
  test("org B cannot revoke org A's credential through the status patch", async () => {
    const response = await signedApp.request(`http://localhost/${credA.id}/status`, as(ORG_B, {
      method: "PATCH",
      body: JSON.stringify({ status: "revoked", error: "cross-tenant revoke" }),
    }))

    expect(response.status).toBe(200)
    const after = registry.getCredential(credA.id, ORG_A)
    expect(after?.status).toBe("available")
    expect(after?.last_error).toBeNull()
  })

  // Verb 3c of 5: OVERWRITE via scope patch (flip another tenant's key to shared).
  test("org B cannot change the scope of org A's credential", async () => {
    const response = await signedApp.request(`http://localhost/${credA.id}/scope`, as(ORG_B, {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
    }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "credential_not_found" } })
    expect(registry.getCredential(credA.id, ORG_A)?.scope).toBe("local")
  })

  // Verb 4a of 5: DELETE by id.
  test("org B cannot delete org A's credential by id", async () => {
    const response = await signedApp.request(`http://localhost/${credA.id}`, as(ORG_B, { method: "DELETE" }))

    await expect(response.json()).resolves.toEqual({ deleted: false })
    expect(registry.getCredential(credA.id, ORG_A)).toBeDefined()
  })

  // Verb 4b of 5: DELETE by provider — the "Remove provider" button. Unscoped
  // it wiped every tenant's key for that provider at once.
  test("org B deleting the provider only removes its own rows", async () => {
    const response = await signedApp.request("http://localhost/provider/openai", as(ORG_B, { method: "DELETE" }))

    await expect(response.json()).resolves.toEqual({ deleted: 1 })
    expect(registry.getCredential(credA.id, ORG_A)).toBeDefined()
    await expect(registry.resolveSecretById(credA.id, ORG_A)).resolves.toBe("sk-org-a-secret")
    expect(registry.getCredentialByProvider("openai", undefined, ORG_B)).toBeUndefined()
  })

  // Verb 5 of 5: FORCE-VERIFY. Beyond the health overwrite, verification sends
  // the victim's secret to the provider — so it must 404 before any egress.
  test("org B cannot force-verify org A's credential", async () => {
    providerFetch.mockClear()
    const response = await signedApp.request(`http://localhost/${credA.id}/verify`, as(ORG_B, { method: "POST" }))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "credential_not_found" } })
    expect(providerFetch).not.toHaveBeenCalled()
    expect(registry.getCredential(credA.id, ORG_A)?.health).toBeNull()
  })

  test("org A can still verify its own credential", async () => {
    providerFetch.mockClear()
    const response = await signedApp.request(`http://localhost/${credA.id}/verify`, as(ORG_A, { method: "POST" }))

    await expect(response.json()).resolves.toEqual({ result: "ok", health: "ok", verified_at: 5_000 })
    expect(providerFetch).toHaveBeenCalledTimes(1)
    expect(registry.getCredential(credA.id, ORG_A)?.health).toBe("ok")
  })

  // An absent org claim must not collapse two principals into one partition.
  test("signed principals with no org claim are partitioned by subject, not shared", async () => {
    const one = await signedApp.request("http://localhost/", as("personal_one", {
      method: "PUT",
      body: JSON.stringify({ provider_id: "anthropic", kind: "api_key", secret: "sk-personal-one" }),
    }))
    const credOne = ((await one.json()) as { credential: { id: string } }).credential

    expect((await listAs("personal_two")).credentials.map((item) => item.id)).not.toContain(credOne.id)
    expect((await listAs("personal_one")).credentials.map((item) => item.id)).toContain(credOne.id)
    expect(registry.getCredential(credOne.id, "personal_one")?.org_id).toBe("personal_one")
    expect(registry.getCredential(credOne.id, SINGLE_TENANT_ORG)).toBeUndefined()
  })

  test("an org-scoped credential is invisible to the single-tenant partition", async () => {
    const listed = await singleTenantApp.request("http://localhost/")
    const body = (await listed.json()) as Listed

    expect(body.credentials.map((item) => item.id)).not.toContain(credA.id)
  })
})

describe("single-tenant self-host still works end to end", () => {
  // Same process, same DB: the unsigned path must remain fully functional
  // alongside the org-scoped rows above.
  test("still pinned to the temp data dir", () => {
    expect(process.env.CLAXEDO_DATA_DIR).toBe(root)
    expect(ClaxedoDB.Path().startsWith(root)).toBe(true)
  })

  test("list, read, overwrite, verify and delete all work with no org identity", async () => {
    const stored = await singleTenantApp.request("http://localhost/", {
      method: "PUT",
      body: JSON.stringify({ provider_id: "anthropic", kind: "api_key", secret: "sk-single-tenant" }),
    })
    const cred = ((await stored.json()) as { credential: { id: string } }).credential
    expect(registry.getCredential(cred.id, SINGLE_TENANT_ORG)?.org_id).toBe(SINGLE_TENANT_ORG)

    const listed = (await (await singleTenantApp.request("http://localhost/")).json()) as Listed
    expect(listed.credentials.map((item) => item.id)).toContain(cred.id)

    const read = await singleTenantApp.request("http://localhost/anthropic")
    await expect(read.json()).resolves.toMatchObject({ credential: { id: cred.id } })

    // Overwrite in place: same row, new secret — the upsert must still match.
    const again = await singleTenantApp.request("http://localhost/", {
      method: "PUT",
      body: JSON.stringify({ provider_id: "anthropic", kind: "api_key", secret: "sk-single-tenant-2" }),
    })
    const rewritten = ((await again.json()) as { credential: { id: string } }).credential
    expect(rewritten.id).toBe(cred.id)
    await expect(registry.resolveSecretById(cred.id, SINGLE_TENANT_ORG)).resolves.toBe("sk-single-tenant-2")

    providerFetch.mockClear()
    const verified = await singleTenantApp.request(`http://localhost/${cred.id}/verify`, { method: "POST" })
    await expect(verified.json()).resolves.toEqual({ result: "ok", health: "ok", verified_at: 5_000 })

    const status = await singleTenantApp.request(`http://localhost/${cred.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "expired" }),
    })
    expect(status.status).toBe(200)
    expect(registry.getCredential(cred.id, SINGLE_TENANT_ORG)?.status).toBe("expired")

    const deleted = await singleTenantApp.request(`http://localhost/${cred.id}`, { method: "DELETE" })
    await expect(deleted.json()).resolves.toEqual({ deleted: true })
    expect(registry.getCredential(cred.id, SINGLE_TENANT_ORG)).toBeUndefined()
  })

  test("registry calls that pass no org read and write the named single-tenant partition", async () => {
    const created = await registry.putCredential({
      provider_id: "openai",
      kind: "subscription_session",
      source: "local_only",
      secret: "sk-default-scope",
    })

    expect(created.org_id).toBe(SINGLE_TENANT_ORG)
    expect(registry.listCredentials().map((item) => item.id)).toContain(created.id)
    // Never a wildcard: the default partition sees only its own rows.
    expect(registry.listCredentials().every((item) => item.org_id === SINGLE_TENANT_ORG)).toBe(true)
    expect(registry.getCredentialByProvider("openai", "subscription_session")?.id).toBe(created.id)
    await expect(registry.deleteCredential(created.id)).resolves.toBe(true)
  })

  /**
   * The dangerous failure mode for this fix is a MISSED statement, not a wrong
   * one — a future exported helper that queries the table and forgets the
   * predicate. Pin it structurally: every `.from/.update/.delete` against the
   * credential table must reach its terminator through the org predicate.
   */
  test("every statement against the credential table carries the org predicate", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dirname, "../registry.ts"), "utf8")
    const heads = [...source.matchAll(/\.(from|update|delete)\(ClaxedoProviderCredentialTable\)/g)]
    expect(heads.length).toBeGreaterThan(10)

    const unscoped = heads
      .map((head) => {
        const start = head.index ?? 0
        const terminator = /\.(all|get|run)\(\)/g
        terminator.lastIndex = start
        const end = terminator.exec(source)?.index ?? start + 400
        return source.slice(start, end)
      })
      // `deleteCredentialsByProvider` shares one predicate local between its
      // read and its delete; the assertion below pins that local's definition.
      .filter((statement) => !/inOrg\(|\.where\(scope\)/.test(statement))

    expect(unscoped, `unscoped credential statements: ${unscoped.join(" | ")}`).toEqual([])
    expect(source).toMatch(/const scope = kind\s*\?\s*and\(\s*inOrg\(org\)/)
    // The one INSERT has no WHERE — it must stamp the column instead.
    expect(source).toContain("db.insert(ClaxedoProviderCredentialTable).values(row)")
    expect(source).toContain("org_id: orgId,")
  })

  test("a blank org resolves to the single-tenant partition rather than matching everything", () => {
    expect(registry.credentialOrg(undefined)).toBe(SINGLE_TENANT_ORG)
    expect(registry.credentialOrg("")).toBe(SINGLE_TENANT_ORG)
    expect(registry.credentialOrg("   ")).toBe(SINGLE_TENANT_ORG)
    expect(registry.credentialOrg(" org_a ")).toBe(ORG_A)
  })
})
