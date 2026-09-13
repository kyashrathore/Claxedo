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
  updateCredentialUsage,
  updateCredentialScope,
  updateCredentialSecret,
  updateCredentialLabel,
  deleteCredential,
  deleteCredentialsByProvider,
  selectCredentialsForScope,
  setActiveCredentials,
  clearActiveCredentials,
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

    setActiveCredentials([oauth.id])
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

  test("replacing the secret supersedes the verdict reached against the old one", async () => {
    const credential = await putCredential({
      provider_id: "verify-refresh-test",
      kind: "oauth_token",
      source: "managed",
      secret: "stale-token",
    })
    updateCredentialHealth(credential.id, "auth_failed", 1234)

    expect(await updateCredentialSecret(credential.id, "renewed-token")).toBe(true)

    expect(getCredential(credential.id)).toMatchObject({
      health: null,
      status: "available",
      last_validated_at: null,
      last_error: null,
      revision: credential.revision + 1,
    })
    expect(await resolveSecretById(credential.id)).toBe("renewed-token")
  })

  test("renaming a credential touches nothing the auth material is judged by", async () => {
    const credential = await putCredential({
      provider_id: "rename-test",
      kind: "api_key",
      source: "managed",
      label: "Work key",
      secret: "rename-secret",
    })
    updateCredentialHealth(credential.id, "auth_failed", 1234)

    expect(updateCredentialLabel(credential.id, "Personal key")).toBe(true)

    expect(getCredential(credential.id)).toMatchObject({
      label: "Personal key",
      health: "auth_failed",
      status: "error",
      last_validated_at: 1234,
      revision: credential.revision,
    })
  })

  test("renaming a credential another org owns writes nothing", async () => {
    const credential = await putCredential({
      provider_id: "rename-org-test",
      kind: "api_key",
      source: "managed",
      label: "Only name",
      secret: "rename-org-secret",
    })

    expect(updateCredentialLabel(credential.id, "Renamed by a stranger", "some-other-org")).toBe(false)

    expect(getCredential(credential.id)).toMatchObject({ label: "Only name" })
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

  test("keeps the quota windows a verification read, and leaves an unread row with none", async () => {
    const read = await putCredential({
      provider_id: "usage-test",
      kind: "oauth_token",
      source: "managed",
      account_id: "acct_usage",
      secret: "usage-secret",
    })
    const unread = await putCredential({
      provider_id: "usage-test-none",
      kind: "oauth_token",
      source: "managed",
      account_id: "acct_none",
      secret: "usage-none-secret",
    })
    expect(read.usage_windows ?? null).toBeNull()
    expect(read.usage_at ?? null).toBeNull()

    const windows = [
      { window: "session", usedPercent: 20.5, resetsAt: 1_757_600_000_000 },
      { window: "weekly", usedPercent: 4, resetsAt: null },
    ]
    updateCredentialUsage(read.id, windows, 1234)

    expect(getCredential(read.id)).toMatchObject({ usage_windows: windows, usage_at: 1234 })
    expect(listCredentials().find((row) => row.id === read.id))
      .toMatchObject({ usage_windows: windows, usage_at: 1234 })
    expect(getCredential(unread.id)?.usage_windows ?? null).toBeNull()
    expect(getCredential(unread.id)?.usage_at ?? null).toBeNull()
  })

  test("a quota read leaves the write clock that orders two accounts alone", async () => {
    const cred = await putCredential({
      provider_id: "usage-order",
      kind: "oauth_token",
      source: "managed",
      account_id: "acct_order",
      secret: "usage-order-secret",
    })
    const before = getCredential(cred.id)?.updated_at
    // `updated_at` is the wall clock. Without a gap either side, a write that
    // DID move it is indistinguishable from one that did not.
    const gap = () => new Promise((resolve) => setTimeout(resolve, 5))

    await gap()
    updateCredentialUsage(cred.id, [{ window: "session", usedPercent: 90, resetsAt: null }], 9999)
    expect(getCredential(cred.id)).toMatchObject({ updated_at: before, usage_at: 9999 })

    // The contrast: a verdict about the account itself is a write, and does
    // move the clock the fanout breaks ties on.
    await gap()
    updateCredentialHealth(cred.id, "ok", 9999)
    expect(getCredential(cred.id)?.updated_at).not.toBe(before)
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

  describe("network policy is not a credential side effect", () => {
    test("storing a credential writes no policy row", async () => {
      const { listPolicies } = await import("../sandbox/network/policy")
      const before = listPolicies()

      await putCredential({
        provider_id: "claude-sdk",
        kind: "api_key",
        source: "managed",
        secret: "sk-ant-no-grant",
      })

      expect(listPolicies()).toEqual(before)
    })

    test("deleting a credential removes no policy row", async () => {
      const { createPolicy, listPolicies } = await import("../sandbox/network/policy")
      createPolicy({ target: "api.no-withdraw.test", kind: "host" })
      const cred = await putCredential({
        provider_id: "codex-app-server",
        kind: "api_key",
        source: "managed",
        secret: "sk-openai-no-withdraw",
      })
      const before = listPolicies()

      await deleteCredential(cred.id)
      await deleteCredentialsByProvider("codex-app-server")

      expect(listPolicies()).toEqual(before)
    })
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

    test("a rejected active account yields the mark to the next key saved", async () => {
      const rejected = await putCredential({
        provider_id: "yield-test",
        kind: "api_key",
        source: "managed",
        secret: "sk-rejected-aaaa",
      })
      expect(rejected.is_active).toBe(true)
      updateCredentialHealth(rejected.id, "auth_failed", 1234)

      const replacement = await putCredential({
        provider_id: "yield-test",
        kind: "api_key",
        source: "managed",
        secret: "sk-working-bbbb",
      })

      expect(replacement.is_active).toBe(true)
      // The rejected account stays listed, with the verdict that is true of it.
      expect(getCredential(rejected.id)).toMatchObject({ is_active: false, status: "error", health: "auth_failed" })
      await expect(resolveSecret("yield-test")).resolves.toBe("sk-working-bbbb")
    })

    test("a rejected active account re-saved with the same key keeps the mark it holds", async () => {
      const account = await putCredential({
        provider_id: "yield-same-key-test",
        kind: "api_key",
        source: "managed",
        secret: "sk-same-cccc",
      })
      updateCredentialHealth(account.id, "auth_failed", 1234)

      const again = await putCredential({
        provider_id: "yield-same-key-test",
        kind: "api_key",
        source: "managed",
        secret: "sk-same-cccc",
      })

      expect(again.id).toBe(account.id)
      expect(again.is_active).toBe(true)
      expect(listCredentials().filter((row) => row.provider_id === "yield-same-key-test")).toHaveLength(1)
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

    async function thirdAccount(providerId: string) {
      return putCredential({
        provider_id: providerId,
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_third",
        label: "third",
        secret: "third-secret",
      })
    }

    test("removing the active account hands the mark to the oldest account left", async () => {
      const { first, second } = await twoAccounts("active-remove")
      const third = await thirdAccount("active-remove")
      expect(first.is_active).toBe(true)

      await deleteCredential(first.id)

      expect(getCredential(second.id)?.is_active).toBe(true)
      expect(getCredential(third.id)?.is_active).toBe(false)
      expect(await resolveSecret("active-remove")).toBe("second-secret")
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-remove"))
        .toMatchObject([{ id: second.id }])
    })

    test("the account that takes the mark is one the provider can still run on", async () => {
      const { first, second } = await twoAccounts("active-remove-skip")
      const third = await thirdAccount("active-remove-skip")
      updateCredentialStatus(second.id, "expired")

      await deleteCredential(first.id)

      expect(getCredential(second.id)?.is_active).toBe(false)
      expect(getCredential(third.id)?.is_active).toBe(true)
      expect(await resolveSecret("active-remove-skip")).toBe("third-secret")
    })

    test("removing every account of a provider leaves nothing marked", async () => {
      const { first, second } = await twoAccounts("active-remove-all")

      await deleteCredential(first.id)
      expect(getCredential(second.id)?.is_active).toBe(true)
      await deleteCredential(second.id)

      expect(listCredentials().filter((row) => row.provider_id === "active-remove-all")).toEqual([])
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-remove-all")).toEqual([])
    })

    test("removing the active account marks nothing when the rest are rejected", async () => {
      const { first, second } = await twoAccounts("active-remove-rejected")
      updateCredentialHealth(second.id, "auth_failed", 1234)

      await deleteCredential(first.id)

      expect(getCredential(second.id)).toMatchObject({ is_active: false, status: "error" })
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-remove-rejected"))
        .toEqual([])
    })

    test("removing an account that never held the mark leaves the marked one alone", async () => {
      const { first, second } = await twoAccounts("active-remove-inactive")

      await deleteCredential(second.id)

      expect(getCredential(first.id)?.is_active).toBe(true)
    })

    test("a refused active account hands the mark to the oldest account left", async () => {
      const { first, second } = await twoAccounts("active-refused")
      const third = await thirdAccount("active-refused")
      expect(first.is_active).toBe(true)

      updateCredentialHealth(first.id, "auth_failed", 1234)

      expect(getCredential(first.id)).toMatchObject({ is_active: false, health: "auth_failed" })
      expect(getCredential(second.id)?.is_active).toBe(true)
      expect(getCredential(third.id)?.is_active).toBe(false)
      expect(await resolveSecret("active-refused")).toBe("second-secret")
    })

    test("expiry and a missing subscription move the mark; a rate cap does not", async () => {
      for (const health of ["expired", "no_billing"] as const) {
        const { first, second } = await twoAccounts(`active-refused-${health}`)
        updateCredentialHealth(first.id, health, 1234)
        expect(getCredential(first.id)?.is_active, health).toBe(false)
        expect(getCredential(second.id)?.is_active, health).toBe(true)
      }

      const { first, second } = await twoAccounts("active-rate-capped")
      updateCredentialHealth(first.id, "rate_capped", 1234)

      expect(getCredential(first.id)).toMatchObject({ is_active: true, health: "rate_capped" })
      expect(getCredential(second.id)?.is_active).toBe(false)
    })

    test("a refused account with nowhere to hand the mark keeps it", async () => {
      const { first, second } = await twoAccounts("active-refused-alone")
      updateCredentialHealth(second.id, "auth_failed", 1234)

      updateCredentialHealth(first.id, "auth_failed", 1234)

      expect(getCredential(first.id)).toMatchObject({ is_active: true, health: "auth_failed" })
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-refused-alone"))
        .toEqual([])
    })

    test("a refused account that never held the mark leaves the marked one alone", async () => {
      const { first, second } = await twoAccounts("active-refused-inactive")

      updateCredentialHealth(second.id, "auth_failed", 1234)

      expect(getCredential(first.id)?.is_active).toBe(true)
      expect(getCredential(second.id)?.is_active).toBe(false)
    })

    test("clearActiveCredentials leaves the provider unmarked, so its harness runs on the machine login", async () => {
      const { first, second } = await twoAccounts("active-clear")

      expect(clearActiveCredentials(["active-clear"])).toEqual({ cleared: [first.id] })

      expect(getCredential(first.id)?.is_active).toBe(false)
      expect(getCredential(second.id)?.is_active).toBe(false)
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-clear")).toEqual([])
    })

    test("clearActiveCredentials reaches only the org it was asked in", async () => {
      const mine = await putCredential({
        provider_id: "active-clear-org",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_mine",
        label: "mine",
        secret: "mine-secret",
      }, "org-a")
      const theirs = await putCredential({
        provider_id: "active-clear-org",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_theirs",
        label: "theirs",
        secret: "theirs-secret",
      }, "org-b")
      expect(getCredential(mine.id, "org-a")?.is_active).toBe(true)
      expect(getCredential(theirs.id, "org-b")?.is_active).toBe(true)

      expect(clearActiveCredentials(["active-clear-org"], "org-a")).toEqual({ cleared: [mine.id] })

      expect(getCredential(mine.id, "org-a")?.is_active).toBe(false)
      expect(getCredential(theirs.id, "org-b")?.is_active).toBe(true)
      // And the default partition, which holds neither of them, is untouched by
      // a call naming the same provider.
      expect(clearActiveCredentials(["active-clear-org"])).toEqual({ cleared: [] })
      expect(getCredential(theirs.id, "org-b")?.is_active).toBe(true)
    })

    test("a sandbox driver key neither holds the mark nor inherits it", async () => {
      const driver = await putCredential({
        provider_id: "daytona",
        kind: "sandbox_driver",
        source: "managed",
        label: "driver",
        secret: "daytona-key",
      })
      // Nothing a harness runs on, so the mark never lands on it at save time…
      expect(driver.is_active).toBe(false)

      const mixed = await putCredential({
        provider_id: "daytona",
        kind: "api_key",
        source: "managed",
        label: "model key",
        secret: "sk-daytona-model",
      })
      expect(mixed.is_active).toBe(true)
      expect(setActiveCredentials([driver.id])).toEqual({ ok: false, reason: "not_eligible" })

      // …nor when the account that did hold it is refused and looks for an heir.
      updateCredentialHealth(mixed.id, "auth_failed", 1234)

      expect(getCredential(driver.id)?.is_active).toBe(false)
      expect(getCredential(mixed.id)?.is_active).toBe(true)
      expect(clearActiveCredentials(["daytona"])).toEqual({ cleared: [mixed.id] })
    })

    test("clearActiveCredentials clears every binding named and nothing else", async () => {
      const { first } = await twoAccounts("active-clear-a")
      const other = await twoAccounts("active-clear-b")
      const untouched = await twoAccounts("active-clear-c")

      expect(clearActiveCredentials(["active-clear-a", "active-clear-b", "active-clear-missing"]).cleared.toSorted())
        .toEqual([first.id, other.first.id].toSorted())

      expect(getCredential(untouched.first.id)?.is_active).toBe(true)
    })

    test("setActiveCredentials moves the mark, and the fanout sends the account it moved to", async () => {
      const { first, second } = await twoAccounts("active-switch")
      expect(await resolveSecret("active-switch")).toBe("first-secret")

      const result = setActiveCredentials([second.id])

      expect(result).toMatchObject({ ok: true, credentials: [{ id: second.id, is_active: true }] })
      expect(getCredential(first.id)?.is_active).toBe(false)
      expect(await resolveSecret("active-switch")).toBe("second-secret")
      expect(selectCredentialsForScope("local").filter((row) => row.provider_id === "active-switch"))
        .toMatchObject([{ id: second.id }])
    })

    test("setActiveCredentials refuses an id it cannot see and one that never reaches a harness", async () => {
      const driver = await putCredential({
        provider_id: "active-driver",
        kind: "sandbox_driver",
        source: "managed",
        secret: "daytona-master-key",
      })
      const { first } = await twoAccounts("active-other-org")

      expect(setActiveCredentials([randomUUID()])).toEqual({ ok: false, reason: "not_found" })
      expect(setActiveCredentials([first.id], "some-other-org")).toEqual({ ok: false, reason: "not_found" })
      expect(setActiveCredentials([driver.id])).toEqual({ ok: false, reason: "not_eligible" })
      expect(getCredential(driver.id)?.is_active).toBe(false)
    })

    test("every binding of one account is marked in a single call", async () => {
      const bindings = await Promise.all(["binding-acp", "binding-sdk"].map((providerId) => putCredential({
        provider_id: providerId,
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_old",
        secret: `${providerId}-old`,
      })))
      const replacing = await Promise.all(["binding-acp", "binding-sdk"].map((providerId) => putCredential({
        provider_id: providerId,
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_new",
        secret: `${providerId}-new`,
      })))

      const result = setActiveCredentials(replacing.map((row) => row.id))

      expect(result).toMatchObject({ ok: true })
      expect(replacing.every((row) => getCredential(row.id)?.is_active === true)).toBe(true)
      expect(bindings.some((row) => getCredential(row.id)?.is_active === true)).toBe(false)
      expect(await resolveSecret("binding-acp")).toBe("binding-acp-new")
      expect(await resolveSecret("binding-sdk")).toBe("binding-sdk-new")
    })

    test("one refused id leaves every partition in the call untouched", async () => {
      const holder = await putCredential({
        provider_id: "atomic-binding",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_old",
        secret: "atomic-old",
      })
      const account = await putCredential({
        provider_id: "atomic-binding",
        kind: "oauth_token",
        source: "managed",
        account_id: "acc_new",
        secret: "atomic-new",
      })
      const driver = await putCredential({
        provider_id: "atomic-driver",
        kind: "sandbox_driver",
        source: "managed",
        secret: "atomic-driver-key",
      })
      expect(getCredential(account.id)?.is_active).toBe(false)

      expect(setActiveCredentials([account.id, driver.id])).toEqual({ ok: false, reason: "not_eligible" })

      expect(getCredential(account.id)?.is_active).toBe(false)
      expect(getCredential(holder.id)?.is_active).toBe(true)
      expect(await resolveSecret("atomic-binding")).toBe("atomic-old")
    })

    test("two ids competing for one provider are refused rather than one of them chosen", async () => {
      const { first, second } = await twoAccounts("ambiguous-mark")

      expect(setActiveCredentials([first.id, second.id])).toEqual({ ok: false, reason: "ambiguous" })
      expect(setActiveCredentials([second.id, second.id])).toEqual({ ok: false, reason: "ambiguous" })

      expect(getCredential(first.id)?.is_active).toBe(true)
      expect(getCredential(second.id)?.is_active).toBe(false)
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

      setActiveCredentials([shared.id])

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
