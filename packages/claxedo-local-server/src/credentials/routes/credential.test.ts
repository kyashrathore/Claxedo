import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { CredentialRoutes } from "./credential"
import { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"
import { localControlPlaneCredentials } from "../machine-credentials"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"
import type { CredentialHealth, CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { CredentialDiscoveryError } from "@claxedo/server-core/credentials/operations/discovery"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { SINGLE_TENANT_ORG } from "@claxedo/server-core/credentials/provider-credential.sql"

/** A fetch body this suite always sends as JSON text; anything else is a bug in the test. */
function jsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") throw new Error(`expected a JSON string request body, got ${typeof body}`)
  return JSON.parse(body)
}

/** The absolute URL a fetch call targeted, for whichever RequestInfo shape it used. */
function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString()
}

function providerFetch(response: () => Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
}

/** Everything the server logger wrote while a request ran; `Log` targets stderr directly. */
function captureStderr() {
  const lines: string[] = []
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  })
  return { lines: () => lines, stop: () => spy.mockRestore() }
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
      revision: 1,
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
      revision: 1,
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

  test("reports the credential each provider runs on, without its secret", async () => {
    const registry = Object.assign(credentials(), {
      effectiveCredentials: vi.fn(async (scope: "local" | "shared") => scope === "local"
        ? [{
            id: "cred_1", provider_id: "codex-app-server", kind: "oauth_token" as const, source: "managed" as const,
            label: "ChatGPT OAuth", account_id: "acc_1", secure_ref: "local:1", status: "available" as const,
            health: null, expires_at: null, last_validated_at: null, last_error: null, created_at: 1, updated_at: 1, revision: 1,
          }]
        : []),
    })
    const response = await CredentialRoutes(registry, {}).request("http://localhost/effective")
    expect(response.status).toBe(200)
    const body = await response.json() as { scope: string; credentials: Array<Record<string, unknown>> }
    expect(body.scope).toBe("local")
    expect(body.credentials).toHaveLength(1)
    expect(body.credentials[0]).toMatchObject({ id: "cred_1", provider_id: "codex-app-server", label: "ChatGPT OAuth", has_secret: true })
    expect(JSON.stringify(body)).not.toContain("secure_ref")
    const shared = await CredentialRoutes(registry, {}).request("http://localhost/effective?scope=shared")
    await expect(shared.json()).resolves.toMatchObject({ scope: "shared", credentials: [] })
  })

  test("discovers redacted credentials and saves only the selected preview", async () => {
    const registry = Object.assign(credentials(), {
      discoverLocalCredentials: vi.fn(async () => ({
        discovery_id: "discovery-1",
        items: [{
          provider_id: "openai",
          kind: "oauth_token" as const,
          label: "Codex subscription",
          origin: "~/.codex/auth.json",
        }],
      })),
      saveDiscoveredCredentials: vi.fn(async () => ({
        saved: [{ credential_id: "cred_1", provider_id: "openai", kind: "oauth_token" as const }],
      })),
    })
    const app = CredentialRoutes(registry)

    const discover = await app.request("http://localhost/discover", { method: "POST" })
    const preview = await discover.json()
    const save = await app.request("http://localhost/save-discovered", {
      method: "POST",
      body: JSON.stringify({
        discovery_id: "discovery-1",
        items: [{ provider_id: "openai", kind: "oauth_token", scope: "shared" }],
      }),
    })
    const saved = await save.json()

    expect(discover.status).toBe(200)
    expect(save.status).toBe(200)
    expect(registry.saveDiscoveredCredentials).toHaveBeenCalledWith({
      discovery_id: "discovery-1",
      items: [{ provider_id: "openai", kind: "oauth_token", scope: "shared" }],
    }, SINGLE_TENANT_ORG)
    expect({ preview, saved }).toMatchInlineSnapshot(`
      {
        "preview": {
          "discovery_id": "discovery-1",
          "items": [
            {
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
              "credential_id": "cred_1",
              "kind": "oauth_token",
              "provider_id": "openai",
            },
          ],
        },
      }
    `)
    expect(JSON.stringify({ preview, saved })).not.toContain("secret")
  })

  test("a selection that does not name the candidate's shape is refused", async () => {
    // Two candidates can share a provider id and differ only by kind, so a
    // selection without one names neither of them.
    const registry = Object.assign(credentials(), { saveDiscoveredCredentials: vi.fn() })
    const app = CredentialRoutes(registry)

    const save = await app.request("http://localhost/save-discovered", {
      method: "POST",
      body: JSON.stringify({
        discovery_id: "discovery-1",
        items: [{ provider_id: "openai", scope: "shared" }],
      }),
    })

    expect(save.status).toBe(400)
    expect(registry.saveDiscoveredCredentials).not.toHaveBeenCalled()
  })

  test("a discovery that throws names its cause in the body and in a warn log", async () => {
    const registry = Object.assign(credentials(), {
      discoverLocalCredentials: vi.fn(async () => {
        throw new Error("User agent config contains invalid JSON")
      }),
    })
    const logged = captureStderr()

    const response = await CredentialRoutes(registry).request("http://localhost/discover", { method: "POST" })
    const body = await response.json()
    logged.stop()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: {
        code: "credential_discovery_failed",
        message: "Failed to discover credentials",
        details: { detail: { name: "Error", message: "User agent config contains invalid JSON" } },
      },
    })
    expect(logged.lines().join("")).toContain("WARN  Credential discovery failed")
    expect(logged.lines().join("")).toContain("User agent config contains invalid JSON")
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
      ...(await credentials().listCredentials())[0],
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
    expect(jsonBody(request.mock.calls[0]?.[1]?.body)).toMatchObject({ max_output_tokens: 1 })
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)

    const list = await app.request("http://localhost/")
    await expect(list.json()).resolves.toMatchObject({
      credentials: [{ id: "cred_1", health: "ok", last_validated_at: 42 }],
    })
  })

  test("hands back the plan's usage windows when the provider reports them", async () => {
    const row = {
      ...(await credentials().listCredentials())[0],
      provider_id: "codex-app-server",
      kind: "oauth_token" as const,
      health: null,
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => JSON.stringify({ tokens: { access_token: "access_1", account_id: "acct_1" } })),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = providerFetch(() => Response.json({
      rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_757_600_000 } },
    }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 42 })

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      result: "ok",
      health: "ok",
      verified_at: 42,
      usage: [{ window: "session", usedPercent: 20, resetsAt: 1_757_600_000_000 }],
    })
    expect(requestUrl(request.mock.calls[0][0])).toBe("https://chatgpt.com/backend-api/wham/usage")
  })

  test("timestamps health when provider verification completes", async () => {
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
    const row = { ...(await credentials().listCredentials())[0], expires_at: 0, health: null }
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
      ...(await credentials().listCredentials())[0],
      provider_id: "claude-sdk",
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
    const [url, init] = request.mock.calls[0]
    expect(requestUrl(url)).toBe("https://api.anthropic.com/v1/messages")
    expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-route-secret")
    expect(jsonBody(init?.body)).toMatchObject({ max_tokens: 1 })
  })

  test("redacts credential and provider secrets from every verification response", async () => {
    const secret = "adversarial-super-secret"
    const row = {
      ...(await credentials().listCredentials())[0],
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
              "consent": null,
              "created_at": 1,
              "expires_at": null,
              "has_secret": true,
              "health": null,
              "id": "cred_1",
              "is_active": false,
              "kind": "api_key",
              "label": "OpenAI",
              "last_error": null,
              "last_used_at": null,
              "last_validated_at": 1,
              "owner": null,
              "provider_id": "unsupported-provider",
              "scope": "local",
              "source": "managed",
              "status": "available",
              "updated_at": 1,
              "usage_at": null,
              "usage_windows": null,
            },
          ],
        },
        "verify": {
          "error": {
            "code": "credential_verification_failed",
            "details": {
              "detail": {
                "message": "Credential provider does not support verification",
                "name": "Error",
              },
            },
            "message": "Credential verification failed",
          },
        },
      }
    `)
  })

  test("returns a secret-safe upstream error when the provider request fails", async () => {
    const secret = "network-failure-secret"
    const row = { ...(await credentials().listCredentials())[0], health: null }
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
        details: { detail: { name: "Error", message: "Credential provider request failed" } },
      },
    })
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(registry.updateCredentialHealth).not.toHaveBeenCalled()
  })

  test("a verification failure names its cause in the body and in a warn log", async () => {
    const row = { ...(await credentials().listCredentials())[0], health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => "sk-live-1"),
      updateCredentialHealth: vi.fn(async () => {
        throw new TypeError("credential store is closed")
      }),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    })
    const logged = captureStderr()

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const body = await response.json()
    logged.stop()

    expect(response.status).toBe(500)
    expect(body).toEqual({
      error: {
        code: "credential_verification_failed",
        message: "Credential verification failed",
        details: { detail: { name: "TypeError", message: "credential store is closed" } },
      },
    })
    expect(logged.lines().join("")).toContain("WARN  Credential verification failed")
    expect(logged.lines().join("")).toContain("credential store is closed")
  })

  test("a cause that quotes the secret reaches neither the body nor the log", async () => {
    const secret = "sk-live-do-not-log"
    const row = { ...(await credentials().listCredentials())[0], health: null }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      resolveCredentialSecretById: vi.fn(async () => secret),
      updateCredentialHealth: vi.fn(async () => {
        throw new Error(`store rejected ${secret}`)
      }),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    })
    const logged = captureStderr()

    const response = await app.request("http://localhost/cred_1/verify", { method: "POST" })
    const body = await response.json()
    logged.stop()

    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(logged.lines().join("")).not.toContain(secret)
    expect(JSON.stringify(body)).toContain("store rejected [redacted]")
  })

  test("the surface a row was consented from survives redaction", async () => {
    // It is the only record that a login was read off this machine rather than
    // typed in, and Settings names the row from it.
    const row = {
      ...(await credentials().listCredentials())[0],
      consent: { at: 5, surface: "desktop_discovery" as const },
    }
    const registry = Object.assign(credentials(), { listCredentials: vi.fn(async () => [row]) })

    const list = await CredentialRoutes(registry).request("http://localhost/")

    const body = await list.json() as { credentials: Array<{ consent: unknown }> }
    expect(body.credentials[0].consent).toEqual({ at: 5, surface: "desktop_discovery" })
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
        owner: null,
        is_active: false,
        status: "available",
        health: null,
        has_secret: true,
        expires_at: null,
        last_validated_at: 1,
        scope: "local",
        consent: null,
        last_used_at: null,
        last_error: null,
        created_at: 1,
        updated_at: 1,
        usage_windows: null,
        usage_at: null,
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
      ...(await credentials().listCredentials())[0],
      provider_id: "claude-sdk",
      kind: "oauth_token" as const,
    }
    const registry = Object.assign(credentials(), {
      listCredentials: vi.fn(async () => [row]),
      getCredentialByProvider: vi.fn(async () => row),
    })
    const app = CredentialRoutes(registry)

    const list = await app.request("http://localhost/")
    const byProvider = await app.request("http://localhost/claude-sdk")

    await expect(list.json()).resolves.toMatchObject({
      credentials: [{ provider_id: "claude-sdk", kind: "oauth_token" }],
    })
    await expect(byProvider.json()).resolves.toMatchObject({
      credential: { provider_id: "claude-sdk", kind: "oauth_token" },
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

describe("replacing the token on a stored account", () => {
  test("writes the new secret onto the same row, then verifies it", async () => {
    const row: CredentialMetadata = {
      ...(await credentials().listCredentials())[0],
      health: "auth_failed",
      last_validated_at: 7,
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async (id: string) => id === row.id ? row : undefined),
      updateCredentialSecret: vi.fn(async () => true),
      updateCredentialHealth: vi.fn(async (id: string, health: CredentialHealth, validatedAt: number) => {
        row.health = health
        row.last_validated_at = validatedAt
      }),
    })
    const request = providerFetch(() => Response.json({ id: "response_1" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 42 })

    const response = await app.request("http://localhost/cred_1/reconnect", {
      method: "POST",
      body: JSON.stringify({ secret: "sk-fresh" }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ result: "ok", health: "ok", verified_at: 42 })
    expect(registry.updateCredentialSecret).toHaveBeenCalledWith("cred_1", "sk-fresh", undefined, SINGLE_TENANT_ORG)
    expect(registry.updateCredentialHealth).toHaveBeenCalledWith("cred_1", "ok", 42, SINGLE_TENANT_ORG)
    // The new material is what the provider was asked about, not the one the
    // row was rejected for.
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer sk-fresh" })
  })

  test("judges the pasted secret rather than the expiry the replaced one carried", async () => {
    const row: CredentialMetadata = {
      ...(await credentials().listCredentials())[0],
      expires_at: 1,
      health: "expired",
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      updateCredentialSecret: vi.fn(async () => true),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const request = providerFetch(() => Response.json({ id: "response_1" }))
    const app = CredentialRoutes(registry, { fetch: request as unknown as typeof fetch, now: () => 42 })

    const response = await app.request("http://localhost/cred_1/reconnect", {
      method: "POST",
      body: JSON.stringify({ secret: "sk-fresh" }),
    })

    await expect(response.json()).resolves.toMatchObject({ health: "ok" })
    expect(request).toHaveBeenCalledOnce()
  })

  test("names the row by the address the provider gave, unless the user already named it", async () => {
    const claims = Buffer.from(JSON.stringify({ email: "work@acme.com" })).toString("base64url")
    const secret = JSON.stringify({ tokens: { access_token: `a.${claims}.c`, account_id: "acct_1" } })
    const unnamed: CredentialMetadata = {
      ...(await credentials().listCredentials())[0],
      provider_id: "codex-app-server",
      kind: "oauth_token",
      label: "codex-app-server",
    }
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => unnamed),
      updateCredentialSecret: vi.fn(async () => true),
      updateCredentialHealth: vi.fn(async () => {}),
      updateCredentialLabel: vi.fn(async () => true),
    })
    const app = CredentialRoutes(registry, {
      fetch: providerFetch(() => Response.json({ rate_limit: {} })) as unknown as typeof fetch,
      now: () => 42,
    })

    await app.request("http://localhost/cred_1/reconnect", { method: "POST", body: JSON.stringify({ secret }) })

    expect(registry.updateCredentialLabel).toHaveBeenCalledWith("cred_1", "work@acme.com", SINGLE_TENANT_ORG)

    const named = { ...unnamed, label: "My work ChatGPT" }
    const second = Object.assign(credentials(), {
      getCredential: vi.fn(async () => named),
      updateCredentialSecret: vi.fn(async () => true),
      updateCredentialHealth: vi.fn(async () => {}),
      updateCredentialLabel: vi.fn(async () => true),
    })
    const secondApp = CredentialRoutes(second, {
      fetch: providerFetch(() => Response.json({ rate_limit: {} })) as unknown as typeof fetch,
      now: () => 42,
    })

    await secondApp.request("http://localhost/cred_1/reconnect", { method: "POST", body: JSON.stringify({ secret }) })

    expect(second.updateCredentialLabel).not.toHaveBeenCalled()
  })

  test("refuses a row outside the caller's org before any secret is written", async () => {
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => undefined),
      updateCredentialSecret: vi.fn(async () => true),
      updateCredentialHealth: vi.fn(async () => {}),
    })
    const app = CredentialRoutes(registry, { now: () => 42 })

    const response = await app.request("http://localhost/cred_other/reconnect", {
      method: "POST",
      body: JSON.stringify({ secret: "sk-fresh" }),
    })

    expect(response.status).toBe(404)
    expect(registry.updateCredentialSecret).not.toHaveBeenCalled()
  })

  test("rejects a request that carries no secret", async () => {
    const row = (await credentials().listCredentials())[0]
    const registry = Object.assign(credentials(), {
      getCredential: vi.fn(async () => row),
      updateCredentialSecret: vi.fn(async () => true),
    })
    const app = CredentialRoutes(registry, { now: () => 42 })

    const response = await app.request("http://localhost/cred_1/reconnect", {
      method: "POST",
      body: JSON.stringify({ secret: "" }),
    })

    expect(response.status).toBe(400)
    expect(registry.updateCredentialSecret).not.toHaveBeenCalled()
  })
})

describe("what this computer's own logins say", () => {
  test("reports every harness's self-report, and asks only the harness named", async () => {
    const machineLogins = vi.fn(async () => [{
      harness: "claude" as const,
      providerIds: ["claude-acp", "claude-sdk"],
      state: "signed_in" as const,
      email: "person@example.com",
      plan: "max",
    }])
    const app = CredentialRoutes(Object.assign(credentials(), { machineLogins }), {})

    const all = await app.request("http://localhost/machine-logins")
    expect(all.status).toBe(200)
    await expect(all.json()).resolves.toMatchObject({
      machine_logins: [{ harness: "claude", email: "person@example.com", plan: "max" }],
    })
    expect(machineLogins).toHaveBeenCalledWith(undefined, { fresh: false })

    await app.request("http://localhost/machine-logins?harness=codex")
    expect(machineLogins).toHaveBeenLastCalledWith(["codex"], { fresh: false })

    // A row's Check says so, and that is the one read the last answer must not
    // be reused for.
    await app.request("http://localhost/machine-logins?harness=codex&fresh=1")
    expect(machineLogins).toHaveBeenLastCalledWith(["codex"], { fresh: true })
  })

  test("only a caller on this computer may read, or choose, the login it holds", async () => {
    const machineLogins = vi.fn(async () => [])
    const clearActiveCredentials = vi.fn(async () => ({ cleared: [] }))
    const app = CredentialRoutes(Object.assign(credentials(), { machineLogins, clearActiveCredentials }), {})
    const reachedOver: Array<{ url: string; headers: Record<string, string> }> = [
      // A forwarded request destroys the socket-to-client relationship the
      // unsigned-local gate rests on…
      { url: "http://localhost", headers: { "X-Forwarded-For": "10.0.0.1" } },
      // …and a request addressed to a non-loopback host arrived over a network.
      { url: "http://claxedo.example.com", headers: {} },
    ]

    for (const { url, headers } of reachedOver) {
      const read = await app.request(`${url}/machine-logins`, { headers })
      expect(read.status, url).toBe(403)
      await expect(read.json()).resolves.toMatchObject({ error: { code: "loopback_required" } })

      const chosen = await app.request(`${url}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ machine_login: { provider_ids: ["claude-sdk"] } }),
      })
      expect(chosen.status, url).toBe(403)
    }

    expect(machineLogins).not.toHaveBeenCalled()
    expect(clearActiveCredentials).not.toHaveBeenCalled()
    expect((await app.request("http://localhost/machine-logins")).status).toBe(200)
  })

  test("a harness the catalog does not name is refused, and a host that runs none says so", async () => {
    const machineLogins = vi.fn(async () => [])
    const refused = await CredentialRoutes(Object.assign(credentials(), { machineLogins }), {})
      .request("http://localhost/machine-logins?harness=not-a-harness")
    expect(refused.status).toBe(400)
    expect(machineLogins).not.toHaveBeenCalled()

    const unsupported = await CredentialRoutes(credentials(), {}).request("http://localhost/machine-logins")
    expect(unsupported.status).toBe(501)
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "credential_machine_login_unavailable" },
    })
  })
})

describe("choosing which account a provider runs on", () => {
  const root = path.join(realpathSync(os.tmpdir()), `credential-activate-${randomUUID().slice(0, 8)}`)
  let registry: typeof import("@claxedo/server-core/credentials/registry")
  let app: ReturnType<typeof CredentialRoutes>
  let previousDataDir: string | undefined

  beforeAll(async () => {
    mkdirSync(root, { recursive: true })
    previousDataDir = process.env.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_DATA_DIR = root
    const backends = await import("@claxedo/server-core/credentials/backend-registry")
    backends.setBackendOverride(backends.createTestBackend())
    registry = await import("@claxedo/server-core/credentials/registry")
    app = CredentialRoutes(localControlPlaneCredentials(), {})
  })

  afterAll(async () => {
    const backends = await import("@claxedo/server-core/credentials/backend-registry")
    backends.setBackendOverride(undefined)
    const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  async function account(providerId: string, accountId: string) {
    return await registry.putCredential({
      provider_id: providerId,
      kind: "oauth_token",
      source: "managed",
      account_id: accountId,
      label: accountId,
      secret: `${accountId}-secret`,
    })
  }

  function activate(ids: string[]) {
    return app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  }

  test("activate moves the mark in the store, and both listings report it", async () => {
    const first = await account("claude-sdk", "acc_first")
    const second = await account("claude-sdk", "acc_second")

    const listed = await (await app.request("http://localhost/")).json() as {
      credentials: Array<{ id: string; owner: string | null; is_active: boolean }>
    }
    expect(listed.credentials.filter((row) => row.is_active).map((row) => row.id)).toEqual([first.id])
    expect(listed.credentials.every((row) => row.owner === null)).toBe(true)

    const response = await activate([second.id])

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      credentials: [{ id: second.id, is_active: true, owner: null, label: "acc_second" }],
    })
    expect(registry.getCredential(first.id)?.is_active).toBe(false)
    const effective = await (await app.request("http://localhost/effective")).json() as {
      credentials: Array<{ id: string; provider_id: string }>
    }
    expect(effective.credentials.filter((row) => row.provider_id === "claude-sdk").map((row) => row.id))
      .toEqual([second.id])
  })

  test("every binding named in one call is marked together", async () => {
    const acp = await account("binding-acp", "acc_route")
    const sdk = await account("binding-sdk", "acc_route")

    const response = await activate([sdk.id, acp.id])

    expect(response.status).toBe(200)
    const body = await response.json() as { credentials: Array<{ id: string; is_active: boolean }> }
    expect(body.credentials.map((row) => row.id)).toEqual([sdk.id, acp.id])
    expect(body.credentials.every((row) => row.is_active)).toBe(true)
    expect(registry.getCredential(acp.id)?.is_active).toBe(true)
    expect(registry.getCredential(sdk.id)?.is_active).toBe(true)
  })

  test("an unknown id is 404, a credential no harness runs on is 409, and neither writes", async () => {
    const driver = await registry.putCredential({
      provider_id: "daytona",
      kind: "sandbox_driver",
      source: "managed",
      secret: "daytona-master-key",
    })
    const waiting = await account("route-atomic", "acc_waiting")

    const missing = await activate([randomUUID()])
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "credential_not_found" } })

    const ineligible = await activate([waiting.id, driver.id])
    expect(ineligible.status).toBe(409)
    await expect(ineligible.json()).resolves.toMatchObject({ error: { code: "credential_not_activatable" } })
    expect(registry.getCredential(driver.id)?.is_active).toBe(false)
  })

  test("choosing this computer's login leaves the provider with no marked account", async () => {
    const first = await account("machine-choice", "acc_first")
    const second = await account("machine-choice", "acc_second")
    expect(registry.getCredential(first.id)?.is_active).toBe(true)

    const response = await app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_login: { provider_ids: ["machine-choice"] } }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ credentials: [], cleared: [first.id] })
    expect(registry.getCredential(first.id)?.is_active).toBe(false)
    expect(registry.getCredential(second.id)?.is_active).toBe(false)
    const effective = await (await app.request("http://localhost/effective")).json() as {
      credentials: Array<{ provider_id: string }>
    }
    expect(effective.credentials.filter((row) => row.provider_id === "machine-choice")).toEqual([])
  })

  test("a body naming both an account and this computer's login is refused rather than half-obeyed", async () => {
    const first = await account("machine-xor", "acc_first")

    const response = await app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [first.id], machine_login: { provider_ids: ["machine-xor"] } }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "credential_invalid_body" } })
    expect(registry.getCredential(first.id)?.is_active).toBe(true)
  })

  test("a host that is not the machine the harnesses live on says so rather than answering", async () => {
    const hosted = CredentialRoutes(defaultControlPlaneCredentials(), {})
    const seen = await account("machine-hosted", "acc_hosted")

    const read = await hosted.request("http://localhost/machine-logins")
    expect(read.status).toBe(501)
    await expect(read.json()).resolves.toMatchObject({
      error: { code: "credential_machine_login_unavailable" },
    })

    const chosen = await hosted.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_login: { provider_ids: ["machine-hosted"] } }),
    })
    expect(chosen.status).toBe(501)
    expect(registry.getCredential(seen.id)?.is_active).toBe(true)

    // The same two calls against the machine's own composition are answered.
    expect((await app.request("http://localhost/machine-logins")).status).toBe(200)
    expect((await app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machine_login: { provider_ids: ["machine-hosted"] } }),
    })).status).toBe(200)
    expect(registry.getCredential(seen.id)?.is_active).toBe(false)
  })

  test("two ids competing for one provider are refused as a bad request", async () => {
    const first = await account("route-ambiguous", "acc_one")
    const second = await account("route-ambiguous", "acc_two")

    const response = await activate([first.id, second.id])

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "credential_activate_ambiguous" } })
    expect(registry.getCredential(first.id)?.is_active).toBe(true)
    expect(registry.getCredential(second.id)?.is_active).toBe(false)
  })

  test("a body naming no account, or more bindings than a harness has, is refused before the store is touched", async () => {
    await expect(activate([])).resolves.toMatchObject({ status: 400 })
    await expect(activate(Array.from({ length: 9 }, () => randomUUID()))).resolves.toMatchObject({ status: 400 })
    const malformed = await app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({ error: { code: "credential_invalid_body" } })
  })
})

describe("a host that holds one record per provider", () => {
  test("reports activation as unsupported rather than pretending the choice was made", async () => {
    const app = CredentialRoutes(credentials(), {})

    const response = await app.request("http://localhost/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["cred_1"] }),
    })

    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "credential_activate_unsupported" } })
  })
})

describe("how much of a plan is left, kept between reads", () => {
  const root = path.join(realpathSync(os.tmpdir()), `credential-usage-${randomUUID().slice(0, 8)}`)
  let registry: typeof import("@claxedo/server-core/credentials/registry")
  let previousDataDir: string | undefined

  beforeAll(async () => {
    mkdirSync(root, { recursive: true })
    previousDataDir = process.env.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_DATA_DIR = root
    const backends = await import("@claxedo/server-core/credentials/backend-registry")
    backends.setBackendOverride(backends.createTestBackend())
    registry = await import("@claxedo/server-core/credentials/registry")
  })

  afterAll(async () => {
    const backends = await import("@claxedo/server-core/credentials/backend-registry")
    backends.setBackendOverride(undefined)
    const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("a Check stores the windows it reported, and both list reads carry them afterwards", async () => {
    const stored = await registry.putCredential({
      provider_id: "codex-app-server",
      kind: "oauth_token",
      source: "managed",
      account_id: "acct_usage",
      secret: JSON.stringify({ tokens: { access_token: "access_usage", account_id: "acct_usage" } }),
    })
    const request = providerFetch(() => Response.json({
      rate_limit: {
        primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_757_600_000 },
        secondary_window: { used_percent: 4, limit_window_seconds: 604_800, reset_at: 1_758_000_000 },
      },
    }))
    const app = CredentialRoutes(localControlPlaneCredentials(), {
      fetch: request as unknown as typeof fetch,
      now: () => 4242,
    })
    const windows = [
      { window: "session", usedPercent: 20, resetsAt: 1_757_600_000_000 },
      { window: "weekly", usedPercent: 4, resetsAt: 1_758_000_000_000 },
    ]

    const verified = await app.request(`http://localhost/${stored.id}/verify`, { method: "POST" })
    expect(verified.status).toBe(200)
    await expect(verified.json()).resolves.toMatchObject({ health: "ok", usage: windows })

    // A fresh request object, so nothing survives in memory from the Check.
    const list = await CredentialRoutes(localControlPlaneCredentials(), {}).request("http://localhost/")
    const listed = (await list.json() as { credentials: Array<Record<string, unknown>> })
      .credentials.find((row) => row.id === stored.id)
    expect(listed).toMatchObject({ usage_windows: windows, usage_at: 4242 })

    const effective = await CredentialRoutes(localControlPlaneCredentials(), {}).request("http://localhost/effective")
    const chosen = (await effective.json() as { credentials: Array<Record<string, unknown>> })
      .credentials.find((row) => row.provider_id === "codex-app-server")
    expect(chosen).toMatchObject({ id: stored.id, usage_windows: windows, usage_at: 4242 })
  })

  test("a row no Check has reached reports no windows rather than an empty plan", async () => {
    const unread = await registry.putCredential({
      provider_id: "usage-unread",
      kind: "api_key",
      source: "managed",
      secret: "sk-usage-unread",
    })

    const list = await CredentialRoutes(localControlPlaneCredentials(), {}).request("http://localhost/")
    const listed = (await list.json() as { credentials: Array<Record<string, unknown>> })
      .credentials.find((row) => row.id === unread.id)

    expect(listed).toMatchObject({ usage_windows: null, usage_at: null })
  })

  test("a harness that reports its plan once is answered with it on every later read", async () => {
    const reported = [{ window: "session", usedPercent: 61, resetsAt: 1_757_700_000_000 }]
    const login = {
      harness: "codex" as const,
      providerIds: ["codex-app-server", "openai"],
      state: "signed_in" as const,
      email: "person@example.com",
    }
    const app = (usage?: typeof reported, now = 5000) => CredentialRoutes(
      Object.assign(localControlPlaneCredentials(), {
        machineLogins: vi.fn(async () => [usage ? { ...login, usage } : login]),
      }),
      { now: () => now },
    )

    const first = await app(reported, 5000).request("http://localhost/machine-logins")
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      machine_logins: [{ harness: "codex", usage: reported, usageAt: 5000 }],
    })

    // The same harness on a read that carries no windows: the answer is the
    // stored one, and the time it was read rather than the time it was served.
    const later = await app(undefined, 9000).request("http://localhost/machine-logins")
    await expect(later.json()).resolves.toMatchObject({
      machine_logins: [{ harness: "codex", usage: reported, usageAt: 5000 }],
    })
  })

  test("a harness that reports no figures of its own is answered with the machine's probe", async () => {
    const probed = [{ window: "session", usedPercent: 25, resetsAt: 1_757_700_000_000 }]
    const app = CredentialRoutes(
      Object.assign(localControlPlaneCredentials(), {
        machineLogins: vi.fn(async () => [{
          harness: "claude" as const,
          providerIds: ["claude-acp", "claude-sdk"],
          state: "signed_in" as const,
          email: "person@example.com",
        }]),
      }),
      {
        now: () => 5000,
        agentUsage: vi.fn(async () => [
          { agent: "claude", harness: "claude" as const, label: "Claude Code", windows: probed, at: 4_000 },
        ]),
      },
    )

    const response = await app.request("http://localhost/machine-logins")
    await expect(response.json()).resolves.toMatchObject({
      machine_logins: [{ harness: "claude", usage: probed, usageAt: 4_000 }],
    })
  })

  test("a harness with no stored plan and none to report is left as it answered", async () => {
    const app = CredentialRoutes(
      Object.assign(localControlPlaneCredentials(), {
        machineLogins: vi.fn(async () => [{
          harness: "cursor" as const,
          providerIds: ["cursor-acp", "cursor-sdk"],
          state: "signed_in" as const,
          email: "nobody@example.com",
        }]),
      }),
      {},
    )

    const response = await app.request("http://localhost/machine-logins")
    const body = await response.json() as { machine_logins: Array<Record<string, unknown>> }

    expect(body.machine_logins[0]).not.toHaveProperty("usage")
    expect(body.machine_logins[0]).not.toHaveProperty("usageAt")
  })
})
