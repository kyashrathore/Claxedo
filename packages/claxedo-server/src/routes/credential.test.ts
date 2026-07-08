import { describe, expect, test, vi } from "vitest"
import { CredentialRoutes } from "./credential"
import type { ControlPlaneCredentials } from "../control-plane/services"

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
        has_secret: true,
        expires_at: null,
        last_validated_at: 1,
        last_error: null,
        created_at: 1,
        updated_at: 1,
      }],
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
    })

    const sync = await app.request("http://localhost/sync-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_ids: ["openai"] }),
    })
    expect(sync.status).toBe(200)
    expect(registry.syncLocalCredentials).toHaveBeenCalledWith(["openai"])

    const status = await app.request("http://localhost/cred_2/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "revoked", error: "rotated" }),
    })
    expect(status.status).toBe(200)
    expect(registry.updateCredentialStatus).toHaveBeenCalledWith("cred_2", "revoked", "rotated")

    const deleted = await app.request("http://localhost/cred_2", { method: "DELETE" })
    expect(deleted.status).toBe(200)
    expect(registry.deleteCredential).toHaveBeenCalledWith("cred_2")
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
    vi.mocked(registry.putCredential).mockRejectedValueOnce(new Error("failed for sk-test-secret"))
    vi.mocked(registry.syncLocalCredentials).mockRejectedValueOnce(new Error("failed for sk-local-secret"))
    vi.mocked(registry.updateCredentialStatus).mockRejectedValueOnce(new Error("failed for sk-status-secret"))
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
