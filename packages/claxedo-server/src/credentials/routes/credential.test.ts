import { describe, expect, test, vi } from "vitest"
import { CredentialRoutes } from "./credential"
import type { ControlPlaneCredentials } from "../../authority/services"
import type { CredentialHealth, CredentialMetadata } from "../types"
import { CredentialDiscoveryError } from "../operations/discovery"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { SINGLE_TENANT_ORG } from "../provider-credential.sql"

function providerFetch(response: () => Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
}

function credentials(): ControlPlaneCredentials {
  return {
    listCredentials: vi.fn(async () => [{
      id: "cred_1",
      provider_id: "openai",
      kind: "api_key" as const,
      source: "managed" as const,
      label: "OpenAI",
      account_id: null,
      secure_ref: "local:secret",
      status: "available" as const,
      expires_at: null,
      last_validated_at: 1,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    }]),
    getCredentialByProvider: vi.fn(async () => undefined),
    putCredential: vi.fn(async (input: Parameters<ControlPlaneCredentials["putCredential"]>[0]) => ({
      id: "cred_2",
      provider_id: input.provider_id,
      kind: input.kind,
      source: input.source,
      label: input.label ?? null,
      account_id: input.account_id ?? null,
      secure_ref: "local:new",
      status: "available" as const,
      expires_at: input.expires_at ?? null,
      last_validated_at: 2,
      last_error: null,
      created_at: 2,
      updated_at: 2,
    })),
    deleteCredential: vi.fn(async () => true),
    deleteCredentialsByProvider: vi.fn(async () => 3),
    updateCredentialStatus: vi.fn(async () => {}),
    syncLocalCredentials: vi.fn(async () => ({
      synced: ["openai"],
      existing: [],
      missing: [],
      failed: [],
    })),
  }
}

describe("credential routes", () => {
  test("requires the composed principal before any credential operation", async () => {
    const registry = credentials()
    const authenticate = vi.fn(async () => {
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization is required")
    })
    const response = await CredentialRoutes(registry, { authenticate }).request("http://localhost/")

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(registry.listCredentials).not.toHaveBeenCalled()
  })

  test("discovers redacted credentials and saves only the selected preview", async () => {
    const registry = Object.assign(credentials(), {
      discoverLocalCredentials: vi.fn(async () => ({
        discovery_id: "discovery-1",
        items: [{
          provider_id: "openai",
          kind: "oauth_token" as const,
          label: "Codex subscription",
          account_id: "account…1234567890",
          origin: "~/.codex/auth.json",
          fresh_until: 123,
        }],
      })),
      saveDiscoveredCredentials: vi.fn(async () => ({
        saved: [{ credential_id: "cred_1", provider_id: "openai", account_id: "account…1234567890" }],
      })),
    })
    const app = CredentialRoutes(registry)

    const discover = await app.request("http://localhost/discover", { method: "POST" })
    const preview = await discover.json()
    const save = await app.request("http://localhost/save-discovered", {
      method: "POST",
      body: JSON.stringify({
        discovery_id: "discovery-1",
        items: [{ provider_id: "openai", account_id: "account…1234567890", scope: "shared" }],
      }),
    })
    const saved = await save.json()

    expect(discover.status).toBe(200)
    expect(save.status).toBe(200)
    expect(registry.saveDiscoveredCredentials).toHaveBeenCalledWith({
      discovery_id: "discovery-1",
      items: [{ provider_id: "openai", account_id: "account…1234567890", scope: "shared" }],
    }, SINGLE_TENANT_ORG)
    expect({ preview, saved }).toMatchInlineSnapshot(`
      {
        "preview": {
          "discovery_id": "discovery-1",
          "items": [
            {
              "account_id": "account…1234567890",
              "fresh_until": 123,
              "kind": "oauth_token",
              "label": "Codex subscription",
              "origin": "~/.codex/auth.json",
              "provider_id": "openai",
            },
          ],
        },
        "saved": {
          "saved": [
            {
              "account_id": "account…1234567890",
              "credential_id": "cred_1",
              "provider_id": "openai",
            },
          ],
        },
      }
    `)
    expect(JSON.stringify({ preview, saved })).not.toContain("secret")
  })

  test("fails closed when discovery is stale or unknown without exposing details", async () => {
    const registry = Object.assign(credentials(), {
      saveDiscoveredCredentials: vi.fn(async () => {
        throw new CredentialDiscoveryError("discovery_expired")
      }),
    })
    const response = await CredentialRoutes(registry).request("http://localhost/save-discovered", {
      method: "POST",
      body: JSON.stringify({ discovery_id: "stale", items: [] }),
    })

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "discovery_expired",
        message: "The credential discovery can no longer be saved",
      },
    })
  })

  test("changes credential scope with explicit consent timing", async () => {
    const registry = Object.assign(credentials(), {
      updateCredentialScope: vi.fn(async () => true),
    })
    const response = await CredentialRoutes(registry, { now: () => 321 }).request("http://localhost/cred_1/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, scope: "shared" })
    expect(registry.updateCredentialScope).toHaveBeenCalledWith("cred_1", "shared", 321, SINGLE_TENANT_ORG)
  })

  test("verifies a credential with a one-token provider call and lists the persisted health", async () => {
    const row: CredentialMetadata = {
      ...(await credentials().listCredentials())[0]!,
      health: null,
    }
    const registry = Object.assign(credentials(), {
      listCredentials: vi.fn(async () => [row]),
      getCredential: vi.fn(async (id: string) => id === row.id ? row : undefined),
      resolveCredentialSecretById: vi.fn(async (id: string) => id === row.id ? "sk-route-secret" : null),
      updateCredentialHealth: vi.fn(async (id: string, health: CredentialHealth, validatedAt: number) => {
        if (id !== row.id) return
        row.health = health
        row.last_validated_at = validatedAt
      }),
    })
    const request = providerFetch(() => Response.json({ id: "response_1" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 42 })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: "ok", health: "ok", verified_at: 42 })
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", 42, SINGLE_TENANT_ORG)
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ max_output_tokens: 1 })
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)

    const list = await app.request("http://localhost/")
    await expect(list.json()).resolves.toMatchObject({
      credentials: [{ id: "cred_1", health: "ok", last_validated_at: 42 }],
    })
  })

  test("timestamps health when provider verification completes", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-timestamp-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const clock = { value: 1 }
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => {
        clock.value = 2
        return Response.json({ id: "response_1" })
      }) as unknown as typeof fetch,
      now: () => clock.value,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    await expect(response.json()).resolves.toMatchObject({ verified_at: 2 })
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", 2, SINGLE_TENANT_ORG)
  })

  test("classifies provider authentication failures without returning provider or secret text", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-auth-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({ error: { message: "rejected sk-auth-secret" } }, { status: 401 })) as unknown as typeof fetch,
      now: () => 43,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ result: "auth_failed", health: "auth_failed", verified_at: 43 })
    expect(JSON.stringify(body)).not.toContain("sk-auth-secret")
    expect(JSON.stringify(body)).not.toContain("rejected")
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "auth_failed", 43, SINGLE_TENANT_ORG)
  })

  test("classifies forbidden provider credentials as authentication failures", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-forbidden-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({ error: { code: "permission_denied" } }, { status: 403 })) as unknown as typeof fetch,
      now: () => 43,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: "auth_failed", health: "auth_failed" })
  })

  test("classifies a provider quota response caused by missing billing", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-billing-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({
        error: { code: "insufficient_quota", message: "billing rejected sk-billing-secret" },
      }, { status: 429 })) as unknown as typeof fetch,
      now: () => 44,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ result: "no_billing", health: "no_billing", verified_at: 44 })
    expect(JSON.stringify(body)).not.toContain("sk-billing-secret")
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "no_billing", 44, SINGLE_TENANT_ORG)
  })

  test("classifies a temporary provider rate cap", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-rate-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 })) as unknown as typeof fetch,
      now: () => 45,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: "rate_capped", health: "rate_capped", verified_at: 45 })
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "rate_capped", 45, SINGLE_TENANT_ORG)
  })

  test("classifies an expired provider token", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-expired-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({ error: { code: "token_expired" } }, { status: 401 })) as unknown as typeof fetch,
      now: () => 46,
    })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: "expired", health: "expired", verified_at: 46 })
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "expired", 46, SINGLE_TENANT_ORG)
  })

  test("does not contact a provider for metadata that is already expired", async () => {
    const row = { ...(await credentials().listCredentials())[0]!, expires_at: 0, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-expired-metadata-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = providerFetch(() => Response.json({ id: "must_not_run" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 1 })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: "expired", health: "expired" })
    expect(request).not.toHaveBeenCalled()
  })

  test("verifies Anthropic credentials with a one-token Messages request", async () => {
    const row = {
      ...(await credentials().listCredentials())[0]!,
      provider_id: "claude-acp",
      kind: "api_key" as const,
      health: null,
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-ant-route-secret"),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = providerFetch(() => Response.json({ id: "message_1" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 47 })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: "ok", health: "ok" })
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages")
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-route-secret")
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1 })
  })

  test("verifies Codex subscription credentials through the ChatGPT responses endpoint", async () => {
    const row = {
      ...(await credentials().listCredentials())[0]!,
      provider_id: "codex-acp",
      kind: "oauth_token" as const,
      health: null,
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => JSON.stringify({
        access: "codex-access-secret",
        account_id: "account_1",
      })),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = providerFetch(() => Response.json({ id: "response_1" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 48 })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: "ok", health: "ok" })
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer codex-access-secret")
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account_1")
    // This previously asserted `max_output_tokens: 1`, which the ChatGPT-backed
    // Codex endpoint rejects outright ("Unsupported parameter"), along with a
    // string `input`, `store: true`, and `stream: false`. The assertion pinned a
    // request no live subscription could ever answer with 200.
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, store: false })
    expect(Array.isArray(JSON.parse(String(init?.body)).input)).toBe(true)
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("max_output_tokens")
  })

  test("redacts credential and provider secrets from every verification response", async () => {
    const secret = "adversarial-super-secret"
    const row = {
      ...(await credentials().listCredentials())[0]!,
      provider_id: "unsupported-provider",
      secure_ref: `local:${secret}`,
      health: null,
    }
    const registry = Object.assign(credentials(), {
      listCredentials: vi.fn(async () => [row]),
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => secret),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry)

    const verify = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const list = await app.request("http://localhost/")
    const bodies = {
      verify: await verify.json(),
      list: await list.json(),
    }

    expect(JSON.stringify(bodies)).not.toContain(secret)
    expect(JSON.stringify(bodies)).not.toContain("secure_ref")
    expect(bodies).toMatchInlineSnapshot(`
      {
        "list": {
          "credentials": [
            {
              "account_id": null,
              "created_at": 1,
              "expires_at": null,
              "has_secret": true,
              "health": null,
              "id": "cred_1",
              "kind": "api_key",
              "label": "OpenAI",
              "last_error": null,
              "last_used_at": null,
              "last_validated_at": 1,
              "provider_id": "unsupported-provider",
              "scope": "local",
              "source": "managed",
              "status": "available",
              "updated_at": 1,
            },
          ],
        },
        "verify": {
          "error": {
            "code": "credential_verification_failed",
            "message": "Credential verification failed",
          },
        },
      }
    `)
  })

  test("returns a secret-safe upstream error when the provider request fails", async () => {
    const secret = "network-failure-secret"
    const row = { ...(await credentials().listCredentials())[0]!, health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => secret),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error(`socket failed for ${secret}`)
    })
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toEqual({
      error: {
        code: "credential_verification_failed",
        message: "Credential verification failed",
      },
    })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(registry.updateCredentialHealth).not.toHaveBeenCalled()
  })

  test("uses injected credential registry and redacts secret references", async () => {
    const registry = credentials()
    const app = CredentialRoutes(registry)

    const list = await app.request("http://localhost/")
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toEqual({
      credentials: [{
        id: "cred_1",
        provider_id: "openai",
        kind: "api_key",
        source: "managed",
        label: "OpenAI",
        account_id: null,
        status: "available",
        health: null,
        has_secret: true,
        expires_at: null,
        last_validated_at: 1,
        scope: "local",
        last_used_at: null,
        last_error: null,
        created_at: 1,
        updated_at: 1,
      }],
    })
  })

  /**
   * `kind` is what tells the cloud-sharing step which credentials can legitimately
   * run in a sandbox: a discovered Claude subscription login is an 8-hour token
   * owned by another process, and offering it for materialization is the defect
   * this closes. The client cannot make that distinction from `provider_id` alone,
   * so every credential the route serializes must carry its kind.
   */
  test("every serialized credential carries its kind, on the list and by-provider routes", async () => {
    const row = {
      ...(await credentials().listCredentials())[0]!,
      provider_id: "claude-acp",
      kind: "oauth_token" as const,
    }
    const registry = Object.assign(credentials(), {
      listCredentials: vi.fn(async () => [row]),
      getCredentialByProvider: vi.fn(async () => row),
    })
    const app = CredentialRoutes(registry)

    const list = await app.request("http://localhost/")
    const byProvider = await app.request("http://localhost/claude-acp")

    await expect(list.json()).resolves.toMatchObject({
      credentials: [{ provider_id: "claude-acp", kind: "oauth_token" }],
    })
    await expect(byProvider.json()).resolves.toMatchObject({
      credential: { provider_id: "claude-acp", kind: "oauth_token" },
    })
  })

  test("delegates credential mutations through injected services", async () => {
    const registry = credentials()
    const app = CredentialRoutes(registry)

    const put = await app.request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "openai",
        kind: "api_key",
        source: "managed",
        secret: "sk-test",
      }),
    })
    expect(put.status).toBe(200)
    expect(registry.putCredential).toHaveBeenCalledWith({
      provider_id: "openai",
      kind: "api_key",
      source: "managed",
      secret: "sk-test",
    }, SINGLE_TENANT_ORG)

    const sync = await app.request("http://localhost/sync-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_ids: ["openai"] }),
    })
    expect(sync.status).toBe(200)
    expect(registry.syncLocalCredentials).toHaveBeenCalledWith(["openai"], SINGLE_TENANT_ORG)

    const status = await app.request("http://localhost/cred_2/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "revoked", error: "rotated" }),
    })
    expect(status.status).toBe(200)
    expect(registry.updateCredentialStatus).toHaveBeenCalledWith("cred_2", "revoked", "rotated", SINGLE_TENANT_ORG)

    const deleted = await app.request("http://localhost/cred_2", { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(registry.deleteCredential).toHaveBeenCalledWith("cred_2", SINGLE_TENANT_ORG)
  })

  test("returns structured validation errors", async () => {
    const app = CredentialRoutes(credentials())

    for (const request of [
      new Request("http://localhost/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_id: "openai", kind: "api_key" }),
      }),
      new Request("http://localhost/sync-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider_ids: [""] }),
      }),
      new Request("http://localhost/cred_2/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "missing" }),
      }),
    ]) {
      const response = await app.request(request)
      const body = await response.json() as { error?: { code?: string; message?: string; details?: unknown } }

      expect(response.status).toBe(400)
      expect(body.error?.code).toBe("credential_invalid_body")
      expect(body.error?.message).toBe("Invalid credential request body")
      expect(body.error?.details).toBeDefined()
    }
  })

  test("returns structured storage errors without leaking secret-bearing exception text", async () => {
    const registry = credentials()
    ;(registry.putCredential as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("failed for sk-test-secret"))
    ;(registry.syncLocalCredentials as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("failed for sk-local-secret"))
    ;(registry.updateCredentialStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("failed for sk-status-secret"))
    const app = CredentialRoutes(registry)

    const put = await app.request("http://localhost/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "openai",
        kind: "api_key",
        source: "managed",
        secret: "sk-test-secret",
      }),
    })
    expect(put.status).toBe(500)
    await expect(put.json()).resolves.toEqual({
      error: {
        code: "credential_store_failed",
        message: "Failed to store credential",
      },
    })

    const sync = await app.request("http://localhost/sync-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_ids: ["openai"] }),
    })
    expect(sync.status).toBe(500)
    await expect(sync.json()).resolves.toEqual({
      error: {
        code: "credential_sync_failed",
        message: "Failed to sync local credentials",
      },
    })

    const status = await app.request("http://localhost/cred_2/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "error", error: "sk-status-secret" }),
    })
    expect(status.status).toBe(500)
    await expect(status.json()).resolves.toEqual({
      error: {
        code: "credential_status_update_failed",
        message: "Failed to update credential status",
      },
    })
  })
})
