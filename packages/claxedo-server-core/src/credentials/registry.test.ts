import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { eq } from "drizzle-orm"
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
  selectCredentialsForScope,
  setActiveCredential,
} = await import("./registry")
const { ClaxedoProviderCredentialTable } = await import("./provider-credential.sql")

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
    await putCredential({
      provider_id: "codex-app-server",
      kind: "api_key",
      source: "managed",
      secret: "wrong-kind",
    })
    const oauth = await putCredential({
      provider_id: "codex-app-server",
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

    expect(piCredentialProviderIDs("openai-codex")).toEqual(["codex-app-server"])
    // The API key saved first holds the mark, and an API key is not a Codex
    // login however many other accounts the provider holds.
    expect(piRegistryProviderConnected("openai-codex")).toBe(false)

    setActiveCredential(oauth.id)
    expect(piRegistryCredentialProvider("openai-codex")).toBe("codex-app-server")
    expect(piRegistryProviderConnected("openai-codex")).toBe(true)

    updateCredentialStatus(oauth.id, "expired")
    expect(piRegistryProviderConnected("openai-codex")).toBe(false)

    expect(piRegistryCredentialProvider("anthropic")).toBe("anthropic")
    expect(piRegistryProviderConnected("unknown")).toBe(false)
    await deleteCredentialsByProvider("codex-app-server")
    await deleteCredentialsByProvider("anthropic")
  })

  test("re-saving the same key updates that account in place", async () => {
    const first = await putCredential({
      provider_id: "update-test",
      kind: "api_key",
      source: "managed",
      label: "first label",
      secret: "same-key",
    })
    const again = await putCredential({
      provider_id: "update-test",
      kind: "api_key",
      source: "managed",
      label: "second label",
      secret: "same-key",
    })

    expect(again.id).toBe(first.id)
    expect(again.label).toBe("second label")
    expect(listCredentials().filter((c) => c.provider_id === "update-test")).toHaveLength(1)
    await expect(resolveSecret("update-test")).resolves.toBe("same-key")
  })

  test("a second pasted key is a second account, identified by a fingerprint of its own", async () => {
    const first = await putCredential({
      provider_id: "second-paste-test",
      kind: "api_key",
      source: "managed",
      secret: "sk-first-aaaa",
    })
    const second = await putCredential({
      provider_id: "second-paste-test",
      kind: "api_key",
      source: "managed",
      secret: "sk-second-bbbb",
    })

    expect(second.id).not.toBe(first.id)
    expect(first.account_id).toMatch(/^fp_[0-9a-f]{8}…aaaa$/)
    expect(second.account_id).toMatch(/^fp_[0-9a-f]{8}…bbbb$/)
    expect(listCredentials().filter((c) => c.provider_id === "second-paste-test")).toHaveLength(2)
    // The first save took the mark and the second did not steal it.
    expect(first.is_active).toBe(true)
    expect(second.is_active).toBe(false)
    await expect(resolveSecret("second-paste-test")).resolves.toBe("sk-first-aaaa")
  })

  test("a connection secret keeps its single row per provider rather than gaining a fingerprint", async () => {
    const first = await putCredential({
      provider_id: "integration:notion",
      kind: "api_key",
      source: "managed",
      secret: "ntn-first",
    })
    const second = await putCredential({
      provider_id: "integration:notion",
      kind: "api_key",
      source: "managed",
      secret: "ntn-second",
    })

    expect(second.id).toBe(first.id)
    expect(second.account_id).toBeNull()
    expect(second.is_active).toBe(false)
    await expect(resolveSecret("integration:notion")).resolves.toBe("ntn-second")
  })

  test("putCredential keeps api key and oauth credentials mutually exclusive per account", async () => {
    const oauth = await putCredential({
      provider_id: "exclusive-auth-test",
      kind: "oauth_token",
      source: "managed",
      account_id: "acc_1",
      secret: JSON.stringify({ refresh: "old-refresh" }),
    })

    const api = await putCredential({
      provider_id: "exclusive-auth-test",
      kind: "api_key",
      source: "managed",
      account_id: "acc_1",
      secret: "new-api-key",
    })

    const all = listCredentials().filter((cred) => cred.provider_id === "exclusive-auth-test")
    expect(all.map((cred) => cred.kind)).toEqual(["api_key"])
    expect(api.id).not.toBe(oauth.id)
    // The replacement inherits the mark: destroying the active row must not
    // leave the provider with nothing to run on.
    expect(api.is_active).toBe(true)
    expect(await resolveSecret("exclusive-auth-test")).toBe("new-api-key")
    expect(await backend.get(oauth.secure_ref!)).toBeNull()
  })

  test("a token and a key for different accounts of one provider both survive", async () => {
    const token = await putCredential({
      provider_id: "claude-sdk",
      kind: "oauth_token",
      source: "managed",
      label: "setup token",
      secret: "sk-ant-oat01-token",
    })
    const key = await putCredential({
      provider_id: "claude-sdk",
      kind: "api_key",
      source: "managed",
      label: "API key",
      secret: "sk-ant-api03-key",
    })

    const rows = listCredentials().filter((cred) => cred.provider_id === "claude-sdk")
    expect(rows.map((row) => row.id).sort()).toEqual([token.id, key.id].sort())
    expect(rows.filter((row) => row.is_active).map((row) => row.id)).toEqual([token.id])
    await deleteCredentialsByProvider("claude-sdk")
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

  test("clears stale verification health when the same key is saved again", async () => {
    const cred = await putCredential({
      provider_id: "verify-reconnect-test",
      kind: "api_key",
      source: "managed",
      secret: "same-secret",
    })
    updateCredentialHealth(cred.id, "auth_failed", 1234)

    const reconnected = await putCredential({
      provider_id: "verify-reconnect-test",
      kind: "api_key",
      source: "managed",
      secret: "same-secret",
    })

    expect(reconnected.id).toBe(cred.id)
    expect(reconnected).toMatchObject({ health: null, status: "available", last_validated_at: null })
    expect(getCredential(cred.id)).toMatchObject({ health: null, status: "available", last_validated_at: null })
  })

  test("a rejected account keeps its verdict when another key is added beside it", async () => {
    const rejected = await putCredential({
      provider_id: "verify-second-account-test",
      kind: "api_key",
      source: "managed",
      secret: "rejected-secret",
    })
    updateCredentialHealth(rejected.id, "auth_failed", 1234)

    const added = await putCredential({
      provider_id: "verify-second-account-test",
      kind: "api_key",
      source: "managed",
      secret: "added-secret",
    })

    expect(added.id).not.toBe(rejected.id)
    expect(added).toMatchObject({ health: null, status: "available", last_validated_at: null })
    expect(getCredential(rejected.id)).toMatchObject({ health: "auth_failed", status: "error" })
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
      provider_id: "claude-sdk",
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
      provider_id: "claude-sdk",
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
      provider_id: "codex-app-server",
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

  describe("the active account", () => {
    async function twoAccounts(providerId: string) {
      const first = await putCredential({
        provider_id: providerId,
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_first",
        label: "first",
        secret: "first-secret",
      })
      const second = await putCredential({
        provider_id: providerId,
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_second",
        label: "second",
        secret: "second-secret",
      })
      return { first, second }
    }

    test("the database refuses a second active row for one provider and owner", async () => {
      const { second } = await twoAccounts("active-index")

      expect(() =>
        ClaxedoDB.use((db) =>
          db
            .update(ClaxedoProviderCredentialTable)
            .set({ is_active: true })
            .where(eq(ClaxedoProviderCredentialTable.id, second.id))
            .run(),
        ),
      ).toThrow(/UNIQUE/i)
    })

    test("two accounts imported together leave exactly one marked", async () => {
      const saved = await Promise.all(["acc_a", "acc_b"].map((account) => putCredential({
        provider_id: "active-import",
        kind: "oauth_token",
        source: "local_only",
        account_id: account,
        secret: `${account}-secret`,
      })))

      expect(saved.filter((row) => row.is_active)).toHaveLength(1)
      expect(listCredentials().filter((row) => row.provider_id === "active-import" && row.is_active))
        .toHaveLength(1)
    })

    test("setActiveCredential moves the mark, and the fanout sends the account it moved to", async () => {
      const { first, second } = await twoAccounts("active-switch")
      expect(await resolveSecret("active-switch")).toBe("first-secret")

      const result = setActiveCredential(second.id)

      expect(result).toMatchObject({ ok: true, credential: { id: second.id, is_active: true } })
      expect(getCredential(first.id)?.is_active).toBe(false)
      expect(await resolveSecret("active-switch")).toBe("second-secret")
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-switch"))
        .toMatchObject([{ id: second.id }])
      expect(await resolveAllSecrets()).toMatchObject({ "active-switch": "second-secret" })
    })

    test("setActiveCredential refuses an id it cannot see and one that never reaches a harness", async () => {
      const driver = await putCredential({
        provider_id: "active-driver",
        kind: "sandbox_driver",
        source: "managed",
        secret: "daytona-master-key",
      })
      const { first } = await twoAccounts("active-other-org")

      expect(setActiveCredential(randomUUID())).toEqual({ ok: false, reason: "not_found" })
      expect(setActiveCredential(first.id, "some-other-org")).toEqual({ ok: false, reason: "not_found" })
      expect(setActiveCredential(driver.id)).toEqual({ ok: false, reason: "not_eligible" })
      expect(getCredential(driver.id)?.is_active).toBe(false)
    })

    test("deleting the active account leaves the provider with none, and nothing is promoted", async () => {
      const { first, second } = await twoAccounts("active-delete")

      expect(await deleteCredential(first.id)).toBe(true)

      expect(getCredential(second.id)?.is_active).toBe(false)
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-delete")).toEqual([])
      expect(await resolveAllSecrets()).not.toHaveProperty("active-delete")
    })

    test("a shared sandbox gets the active account or nothing, never another account of the same provider", async () => {
      await putCredential({
        provider_id: "active-scope",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_local",
        secret: "local-secret",
      })
      const shared = await putCredential({
        provider_id: "active-scope",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_shared",
        scope: "shared",
        consent: { at: 1, surface: "scope_change" },
        secret: "shared-secret",
      })

      expect(selectCredentialsForScope("shared").filter((row) => row.provider_id === "active-scope")).toEqual([])

      setActiveCredential(shared.id)

      expect(selectCredentialsForScope("shared").filter((row) => row.provider_id === "active-scope"))
        .toMatchObject([{ id: shared.id }])
    })
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
