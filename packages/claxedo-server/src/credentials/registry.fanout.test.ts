import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync, mkdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `cred-fanout-test-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const {
  putCredential,
  readSecretById,
  resolveSecret,
  selectCredentialsForScope,
  setActiveCredentials,
  updateCredentialHealth,
} = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
ClaxedoDB.Drizzle()

/** What a scope's fanout would send: the rows it selects, read through the real backend. */
async function fannedOut(scope: "local" | "shared") {
  const rows = selectCredentialsForScope(scope)
  const entries = await Promise.all(rows.map(async (row) =>
    [row.provider_id, await readSecretById(row.id)] as const))
  return Object.fromEntries(entries)
}

describe("credential fanout fence", () => {
  beforeEach(() => {
    setBackendOverride(createTestBackend())
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("only model/AI-provider auth fans out; drivers, connections, channels do not", async () => {
    // Model/AI providers (allowed): the whole point of the fanout — the agent
    // in the sandbox uses the user's own subscription/keys.
    await putCredential({
      provider_id: "openai",
      kind: "api_key",
      source: "managed",
      secret: "sk-harness",
      scope: "shared",
      consent: { at: 1, surface: "scope_change" },
    })
    await putCredential({
      provider_id: "claude-acp",
      kind: "oauth_token",
      source: "managed",
      secret: "claude-oauth",
      scope: "shared",
      consent: { at: 1, surface: "scope_change" },
    })
    await putCredential({
      provider_id: "anthropic",
      kind: "api_key",
      source: "managed",
      secret: "sk-ant-model",
    })
    // Sandbox-driver credential (fenced): the driver API token controls EVERY
    // sandbox and must never land in a sandbox's own runtime config.
    await putCredential({ provider_id: "daytona", kind: "sandbox_driver", source: "managed", secret: "daytona-master-key" })
    // Connection secret (fenced): reaches consumers only via the token endpoint.
    await putCredential({ provider_id: "integration:notion", kind: "api_key", source: "managed", secret: "ntn-connection-secret" })
    // Channel session state (fenced): namespaced, host-internal.
    await putCredential({
      provider_id: "channel:whatsapp:baileys:auth-state",
      kind: "subscription_session",
      source: "managed",
      secret: JSON.stringify({ creds: "session-blob" }),
    })

    // The "shared" scope is what workspace-supervisor-config-sync pushes into
    // every remote/cloud sandbox's runtime config.
    const shared = await fannedOut("shared")
    expect(shared).toEqual({ openai: "sk-harness", "claude-acp": "claude-oauth" })
    expect(Object.keys(shared)).not.toContain("daytona")
    expect(Object.keys(shared)).not.toContain("integration:notion")
    expect(Object.keys(shared)).not.toContain("channel:whatsapp:baileys:auth-state")

    const local = await fannedOut("local")
    expect(local).toEqual({ openai: "sk-harness", "claude-acp": "claude-oauth", anthropic: "sk-ant-model" })
  })

  test("multi-account fanout selects the same preferred provider row as single resolution", async () => {
    await putCredential({
      provider_id: "multi-account-fanout",
      kind: "oauth_token",
      source: "managed",
      account_id: "healthy",
      expires_at: Date.now() + 60_000,
      secret: "healthy-token",
    })
    const expired = await putCredential({
      provider_id: "multi-account-fanout",
      kind: "oauth_token",
      source: "managed",
      account_id: "written-last-but-expired",
      secret: "expired-token",
    })
    updateCredentialHealth(expired.id, "expired", Date.now())

    await expect(resolveSecret("multi-account-fanout")).resolves.toBe("healthy-token")
    expect((await fannedOut("local"))["multi-account-fanout"]).toBe("healthy-token")
  })

  // A sandbox runs on the account the user chose or on nothing at all. Falling
  // through to another account of the same provider is what a shared scope must
  // never do: the second account may not be consented for a sandbox, and even
  // when it is, running someone's turns on a login they did not pick is the
  // silent substitution the active mark exists to end.
  test("a shared sandbox gets the active account or nothing, never another account of the same provider", async () => {
    const local = await putCredential({
      provider_id: "multi-account-scope",
      kind: "oauth_token",
      source: "managed",
      account_id: "active-local",
      secret: "local-token",
    })
    const shared = await putCredential({
      provider_id: "multi-account-scope",
      kind: "oauth_token",
      source: "managed",
      account_id: "consented-shared",
      expires_at: Date.now() + 60_000,
      scope: "shared",
      consent: { at: 1, surface: "scope_change" },
      secret: "consented-shared-token",
    })

    // The first save holds the mark, and it is local-only: the consented shared
    // account beside it does not stand in for it.
    expect((await fannedOut("local"))["multi-account-scope"]).toBe("local-token")
    expect(await fannedOut("shared")).not.toHaveProperty("multi-account-scope")

    expect(setActiveCredentials([shared.id])).toMatchObject({ ok: true })

    expect((await fannedOut("shared"))["multi-account-scope"]).toBe("consented-shared-token")
    expect((await fannedOut("local"))["multi-account-scope"]).toBe("consented-shared-token")

    // Consent is not enough on its own: an expired active account sends nothing
    // and the local-only one it replaced does not come back.
    updateCredentialHealth(shared.id, "expired", Date.now())
    expect(await fannedOut("shared")).not.toHaveProperty("multi-account-scope")
    expect(await fannedOut("local")).not.toHaveProperty("multi-account-scope")
    expect(local.id).not.toBe(shared.id)
  })
})
