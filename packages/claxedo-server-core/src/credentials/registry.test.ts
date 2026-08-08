import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `cred-registry-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

// Import after setting env
const { createTestBackend, setBackendOverride } = await import("./backend-registry")
const {
  putCredential,
  listCredentials,
  getCredentialByProvider,
  getCredential,
  resolveSecret,
  resolveSecretById,
  updateCredentialStatus,
  updateCredentialHealth,
  updateCredentialScope,
  deleteCredential,
  deleteCredentialsByProvider,
  resolveAllSecrets,
} = await import("./registry")

// Force DB initialization
const { ClaxedoDB } = await import("../platform/db")
const { piCredentialProviderIDs, piRegistryCredentialProvider, piRegistryProviderConnected } = await import("./pi-credentials")
ClaxedoDB.Drizzle() // ensure initialized

describe("credential registry", () => {
  let backend: ReturnType<typeof createTestBackend>

  beforeEach(async () => {
    backend = createTestBackend()
    setBackendOverride(backend)
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("putCredential creates metadata and stores secret in backend", async () => {
    const cred = await putCredential({
      provider_id: "test-provider",
      kind: "api_key",
      source: "managed",
      label: "Test Key",
      secret: "sk-test-12345",
    })

    expect(cred.id).toBeTruthy()
    expect(cred.provider_id).toBe("test-provider")
    expect(cred.kind).toBe("api_key")
    expect(cred.source).toBe("managed")
    expect(cred.label).toBe("Test Key")
    expect(cred.status).toBe("available")
    expect(cred.secure_ref).toBeTruthy()

    // Secret is in the backend, not in the metadata
    const raw = await backend.get(cred.secure_ref!)
    expect(raw).toBe("sk-test-12345")
  })

  test("requires consent for an explicitly shared credential", async () => {
    await expect(putCredential({
      provider_id: "shared-without-consent",
      kind: "api_key",
      source: "managed",
      scope: "shared",
      secret: "must-not-store",
    })).rejects.toThrow("Shared credentials require explicit consent")

    const credential = await putCredential({
      provider_id: "shared-with-consent",
      kind: "api_key",
      source: "managed",
      scope: "shared",
      consent: { at: 123, surface: "desktop_discovery" },
      secret: "stored",
    })
    expect(credential).toMatchObject({
      scope: "shared",
      consent: { at: 123, surface: "desktop_discovery" },
    })
  })

  test("stores multiple accounts for the same provider independently", async () => {
    const first = await putCredential({
      provider_id: "multi-account",
      kind: "oauth_token",
      source: "local_only",
      account_id: "account-one",
      secret: "first",
    })
    const second = await putCredential({
      provider_id: "multi-account",
      kind: "oauth_token",
      source: "local_only",
      account_id: "account-two",
      secret: "second",
    })

    expect(first.id).not.toBe(second.id)
    expect(listCredentials().filter((credential) => credential.provider_id === "multi-account"))
      .toHaveLength(2)
    await expect(resolveSecretById(first.id)).resolves.toBe("first")
    await expect(resolveSecretById(second.id)).resolves.toBe("second")
  })

  test("records scope changes and last use", async () => {
    const credential = await putCredential({
      provider_id: "scope-and-use",
      kind: "api_key",
      source: "local_only",
      scope: "local",
      consent: { at: 1, surface: "desktop_discovery" },
      secret: "secret",
    })

    expect(updateCredentialScope(credential.id, "shared", 456)).toBe(true)
    expect(getCredential(credential.id)).toMatchObject({
      scope: "shared",
      source: "managed",
      consent: { at: 456, surface: "scope_change" },
      last_used_at: null,
    })
    await expect(resolveSecretById(credential.id)).resolves.toBe("secret")
    expect(getCredential(credential.id)?.last_used_at).toEqual(expect.any(Number))
  })

  test("Pi credential mapping validates aliases, status, and credential kind", async () => {
    const stale = await putCredential({
      provider_id: "codex-app-server",
      kind: "api_key",
      source: "managed",
      secret: "wrong-kind",
    })
    updateCredentialStatus(stale.id, "expired")
    await putCredential({
      provider_id: "codex-acp",
      kind: "oauth_token",
      source: "managed",
      secret: "valid-oauth",
    })
    await putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "valid-api-key",
    })

    expect(piCredentialProviderIDs("openai-codex")).toEqual(["codex-app-server", "codex-acp"])
    expect(piRegistryCredentialProvider("openai-codex")).toBe("codex-acp")
    expect(piRegistryCredentialProvider("anthropic")).toBe("anthropic")
    expect(piRegistryProviderConnected("openai-codex")).toBe(true)
    expect(piRegistryProviderConnected("unknown")).toBe(false)
    await deleteCredentialsByProvider("codex-app-server")
    await deleteCredentialsByProvider("codex-acp")
    await deleteCredentialsByProvider("anthropic")
  })

  test("putCredential updates existing credential for same provider+kind", async () => {
    await putCredential({
      provider_id: "update-test",
      kind: "api_key",
      source: "managed",
      secret: "old-key",
    })

    const updated = await putCredential({
      provider_id: "update-test",
      kind: "api_key",
      source: "managed",
      secret: "new-key",
    })

    const resolved = await resolveSecret("update-test")
    expect(resolved).toBe("new-key")

    // Only one credential for this provider
    const all = listCredentials().filter((c) => c.provider_id === "update-test")
    expect(all.length).toBe(1)
  })

  test("putCredential keeps api key and oauth credentials mutually exclusive per provider", async () => {
    const oauth = await putCredential({
      provider_id: "exclusive-auth-test",
      kind: "oauth_token",
      source: "managed",
      secret: JSON.stringify({ refresh: "old-refresh" }),
    })

    const api = await putCredential({
      provider_id: "exclusive-auth-test",
      kind: "api_key",
      source: "managed",
      secret: "new-api-key",
    })

    const all = listCredentials().filter((cred) => cred.provider_id === "exclusive-auth-test")
    expect(all.map((cred) => cred.kind)).toEqual(["api_key"])
    expect(api.id).not.toBe(oauth.id)
    expect(await resolveSecret("exclusive-auth-test")).toBe("new-api-key")
    expect(await backend.get(oauth.secure_ref!)).toBeNull()
  })

  test("putCredential does not treat sandbox driver credentials as API or OAuth auth methods", async () => {
    await putCredential({
      provider_id: "exclusive-sandbox-manager-test",
      kind: "sandbox_driver",
      source: "managed",
      secret: "sandbox-manager-token",
    })

    await putCredential({
      provider_id: "exclusive-sandbox-manager-test",
      kind: "api_key",
      source: "managed",
      secret: "api-token",
    })

    const all = listCredentials()
      .filter((cred) => cred.provider_id === "exclusive-sandbox-manager-test")
      .map((cred) => cred.kind)
      .sort()
    expect(all).toEqual(["api_key", "sandbox_driver"])
  })

  test("listCredentials returns all metadata without secrets", () => {
    const creds = listCredentials()
    expect(Array.isArray(creds)).toBe(true)
    // Metadata never contains raw secret material — only secure_ref
    for (const cred of creds) {
      expect(cred.secure_ref?.startsWith("test:")).toBeTruthy()
    }
  })

  test("getCredentialByProvider finds by provider ID", async () => {
    await putCredential({
      provider_id: "lookup-test",
      kind: "api_key",
      source: "managed",
      secret: "my-key",
    })

    const found = getCredentialByProvider("lookup-test")
    expect(found).toBeTruthy()
    expect(found!.provider_id).toBe("lookup-test")
  })

  test("resolveSecret returns raw secret only for available credentials", async () => {
    const cred = await putCredential({
      provider_id: "resolve-test",
      kind: "api_key",
      source: "managed",
      secret: "secret-value",
    })

    expect(await resolveSecret("resolve-test")).toBe("secret-value")

    // Mark as expired
    updateCredentialStatus(cred.id, "expired")
    expect(await resolveSecret("resolve-test")).toBeNull()
  })

  test("persists provider verification health and keeps failed credentials retryable by id", async () => {
    const cred = await putCredential({
      provider_id: "verify-persistence-test",
      kind: "api_key",
      source: "managed",
      secret: "verify-secret",
    })

    updateCredentialHealth(cred.id, "no_billing", 1234)

    expect(getCredential(cred.id)).toMatchObject({
      health: "no_billing",
      status: "error",
      last_validated_at: 1234,
      last_error: "no_billing",
    })
    expect(await resolveSecret("verify-persistence-test")).toBeNull()
    expect(await resolveSecretById(cred.id)).toBe("verify-secret")
  })

  test("clears stale verification health when a credential is replaced", async () => {
    const cred = await putCredential({
      provider_id: "verify-reconnect-test",
      kind: "api_key",
      source: "managed",
      secret: "old-secret",
    })
    updateCredentialHealth(cred.id, "auth_failed", 1234)

    const reconnected = await putCredential({
      provider_id: "verify-reconnect-test",
      kind: "api_key",
      source: "managed",
      secret: "new-secret",
    })

    expect(reconnected).toMatchObject({ health: null, status: "available", last_validated_at: null })
    expect(getCredential(cred.id)).toMatchObject({ health: null, status: "available", last_validated_at: null })
  })

  test("keeps lifecycle status updates from exposing stale provider health", async () => {
    const cred = await putCredential({
      provider_id: "verify-status-test",
      kind: "api_key",
      source: "managed",
      secret: "status-secret",
    })
    updateCredentialHealth(cred.id, "ok", 1234)

    updateCredentialStatus(cred.id, "revoked", "removed")
    expect(getCredential(cred.id)).toMatchObject({ status: "revoked", health: null })

    updateCredentialStatus(cred.id, "expired")
    expect(getCredential(cred.id)).toMatchObject({ status: "expired", health: "expired" })
  })

  test("deleteCredential removes metadata and backend secret", async () => {
    const cred = await putCredential({
      provider_id: "delete-test",
      kind: "api_key",
      source: "managed",
      secret: "delete-me",
    })

    const deleted = await deleteCredential(cred.id)
    expect(deleted).toBe(true)
    expect(getCredential(cred.id)).toBeUndefined()
    expect(await backend.get(cred.secure_ref!)).toBeNull()
  })

  test("deleteCredentialsByProvider removes all for a provider", async () => {
    await putCredential({
      provider_id: "bulk-delete",
      kind: "api_key",
      source: "managed",
      secret: "key-1",
    })

    const count = await deleteCredentialsByProvider("bulk-delete")
    expect(count).toBe(1)
    expect(getCredentialByProvider("bulk-delete")).toBeUndefined()
  })

  test("resolveAllSecrets returns map of provider→secret for available creds", async () => {
    await putCredential({
      provider_id: "all-1",
      kind: "api_key",
      source: "managed",
      secret: "secret-1",
    })
    await putCredential({
      provider_id: "all-2",
      kind: "api_key",
      source: "managed",
      secret: "secret-2",
    })

    const all = await resolveAllSecrets()
    expect(all["all-1"]).toBe("secret-1")
    expect(all["all-2"]).toBe("secret-2")
  })

  // ── Auto-sync: credential → network policy ───────────────────────────

  test("putCredential auto-creates network preset for known providers", async () => {
    const { listPolicies } = await import("../sandbox/network/policy")

    await putCredential({
      provider_id: "claude-acp",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-auto-test",
    })

    const policies = listPolicies()
    const anthropicPreset = policies.find(
      (p) => p.target === "anthropic" && p.kind === "group",
    )
    expect(anthropicPreset).toBeTruthy()
    expect(anthropicPreset!.constraints.auto).toBe(true)
  })

  test("putCredential is idempotent for network presets", async () => {
    const { listPolicies } = await import("../sandbox/network/policy")

    await putCredential({
      provider_id: "claude-acp",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-auto-test-2",
    })

    const policies = listPolicies()
    const anthropicPresets = policies.filter(
      (p) => p.target === "anthropic" && p.kind === "group",
    )
    // Should still be exactly one, not duplicated
    expect(anthropicPresets.length).toBe(1)
  })

  test("deleteCredential removes auto-created network preset", async () => {
    const { listPolicies } = await import("../sandbox/network/policy")

    const cred = await putCredential({
      provider_id: "codex-acp",
      kind: "api_key",
      source: "managed",
      secret: "sk-openai-delete-test",
    })

    // Preset should exist
    let policies = listPolicies()
    expect(policies.find((p) => p.target === "openai" && p.kind === "group")).toBeTruthy()

    // Delete credential
    await deleteCredential(cred.id)

    // Auto-created preset should be removed
    policies = listPolicies()
    const openaiPresets = policies.filter(
      (p) => p.target === "openai" && p.kind === "group" && p.constraints.auto,
    )
    expect(openaiPresets.length).toBe(0)
  })

  test("putCredential does not create preset for unknown providers", async () => {
    const { listPolicies } = await import("../sandbox/network/policy")
    const before = listPolicies().length

    await putCredential({
      provider_id: "some-unknown-provider",
      kind: "api_key",
      source: "managed",
      secret: "sk-unknown",
    })

    const after = listPolicies().length
    // No new policy should have been created
    expect(after).toBe(before)
  })

  test("putCredential fails closed when backend is unavailable", async () => {
    setBackendOverride({
      async put() { throw new Error("fail") },
      async get() { return null },
      async delete() {},
      async probe() { return false },
    })

    await expect(
      putCredential({
        provider_id: "fail-test",
        kind: "api_key",
        source: "managed",
        secret: "should-fail",
      }),
    ).rejects.toThrow("Secret backend unavailable")

    // Restore
    setBackendOverride(backend)
  })
})
