import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, test, vi } from "vitest"

const root = path.join(realpathSync(os.tmpdir()), `credential-verification-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const previous = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../adapters/credentials/store")
const { putCredential, getCredential, resolveSecretById } = await import("../adapters/credentials/registry")
const { defaultControlPlaneCredentials } = await import("../authority/services")
const { CredentialRoutes } = await import("./credential")
const { ClaxedoDB } = await import("../platform/db/db")

const TOKEN_URL = "https://auth.openai.com/oauth/token"

describe("credential verification integration", () => {
  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = previous
  })

  test("persists the route result and returns that same redacted health from listing", async () => {
    setBackendOverride(createTestBackend())
    const credential = await putCredential({
      provider_id: "openai",
      kind: "api_key",
      source: "managed",
      secret: "sk-integration-secret",
    })
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "response_1" }))
    const app = CredentialRoutes(defaultControlPlaneCredentials(), {
      fetch: request as unknown as typeof fetch,
      now: () => 2_000,
    })

    const verified = await app.request(`http://localhost/${credential.id}/verify`, { method: "POST" })
    const listed = await app.request("http://localhost/")
    const verifiedBody = await verified.json()
    const listedBody = await listed.json() as { credentials: Array<Record<string, unknown>> }

    expect(verifiedBody).toEqual({ result: "ok", health: "ok", verified_at: 2_000 })
    expect(listedBody.credentials.find((item) => item.id === credential.id)).toMatchObject({
      health: "ok",
      status: "available",
      last_validated_at: 2_000,
      has_secret: true,
    })
    expect(JSON.stringify({ verifiedBody, listedBody })).not.toContain("sk-integration-secret")
    expect(JSON.stringify({ verifiedBody, listedBody })).not.toContain(credential.secure_ref)
  })

  // Regression for the reproduced onboarding failure: an imported Codex login
  // whose access token expired hours ago, but whose refresh token is still good,
  // must verify ok — and the renewed token must be the one left in storage.
  test("refreshes a stale Codex credential through the route and persists the renewed secret", async () => {
    setBackendOverride(createTestBackend())
    const credential = await putCredential({
      provider_id: "codex-acp",
      kind: "oauth_token",
      source: "local_only",
      label: "Synced from local Codex auth",
      account_id: "acct_stale",
      expires_at: 1_000,
      secret: JSON.stringify({
        type: "codex_auth",
        tokens: { access_token: "access_stale", refresh_token: "refresh_stale", account_id: "acct_stale" },
        refresh: "refresh_stale",
        access: "access_stale",
        expires: 1_000,
        account_id: "acct_stale",
      }),
    })

    const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === TOKEN_URL) {
        return Response.json({ access_token: "access_renewed", refresh_token: "refresh_renewed" })
      }
      return Response.json({ id: "response_1" })
    })
    const app = CredentialRoutes(defaultControlPlaneCredentials(), {
      fetch: request as unknown as typeof fetch,
      now: () => 2_000,
    })

    const verified = await app.request(`http://localhost/${credential.id}/verify`, { method: "POST" })

    expect(await verified.json()).toEqual({ result: "ok", health: "ok", verified_at: 2_000 })
    // The provider was actually probed, with the renewed token.
    const probe = request.mock.calls.find(([url]) => String(url) !== TOKEN_URL)
    expect(probe).toBeDefined()
    expect((probe![1]?.headers as Record<string, string>).Authorization).toBe("Bearer access_renewed")

    const stored = JSON.parse((await resolveSecretById(credential.id))!) as Record<string, any>
    expect(stored.access).toBe("access_renewed")
    expect(stored.tokens.access_token).toBe("access_renewed")
    expect(stored.tokens.refresh_token).toBe("refresh_renewed")
    // Expiry moved forward, so the next verify does not refresh again.
    expect(getCredential(credential.id)?.expires_at).toBe(2_000 + 55 * 60 * 1000)
    expect(getCredential(credential.id)?.health).toBe("ok")
  })

  test("a Codex credential whose refresh token is rejected stays expired", async () => {
    setBackendOverride(createTestBackend())
    const credential = await putCredential({
      provider_id: "codex-acp",
      kind: "oauth_token",
      source: "local_only",
      account_id: "acct_revoked",
      expires_at: 1_000,
      secret: JSON.stringify({
        type: "codex_auth",
        tokens: { access_token: "access_dead", refresh_token: "refresh_dead", account_id: "acct_revoked" },
        refresh: "refresh_dead",
        access: "access_dead",
        expires: 1_000,
      }),
    })

    const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      // Raw provider response, deliberately not `Response.json({ error: ... })`:
      // that construct is reserved for our own route bodies and is guarded.
      if (String(input) === TOKEN_URL) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      }
      return Response.json({ id: "response_1" })
    })
    const app = CredentialRoutes(defaultControlPlaneCredentials(), {
      fetch: request as unknown as typeof fetch,
      now: () => 2_000,
    })

    const verified = await app.request(`http://localhost/${credential.id}/verify`, { method: "POST" })

    expect(await verified.json()).toEqual({ result: "expired", health: "expired", verified_at: 2_000 })
    expect(request.mock.calls.every(([url]) => String(url) === TOKEN_URL)).toBe(true)
    const stored = JSON.parse((await resolveSecretById(credential.id))!) as Record<string, any>
    expect(stored.access).toBe("access_dead")
    expect(getCredential(credential.id)?.expires_at).toBe(1_000)
  })
})
