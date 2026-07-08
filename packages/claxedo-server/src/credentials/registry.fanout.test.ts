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

const { createTestBackend, setBackendOverride } = await import("./store")
const { putCredential, resolveAllSecrets, resolveSecretsForScope } = await import("./registry")
const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()

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
    await putCredential({ provider_id: "openai", kind: "api_key", source: "managed", secret: "sk-harness" })
    await putCredential({ provider_id: "claude-acp", kind: "oauth_token", source: "managed", secret: "claude-oauth" })
    await putCredential({ provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-model" })
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
    const shared = await resolveSecretsForScope("shared")
    expect(shared).toEqual({ openai: "sk-harness", "claude-acp": "claude-oauth", anthropic: "sk-ant-model" })
    expect(Object.keys(shared)).not.toContain("daytona")
    expect(Object.keys(shared)).not.toContain("integration:notion")
    expect(Object.keys(shared)).not.toContain("channel:whatsapp:baileys:auth-state")

    const local = await resolveSecretsForScope("local")
    expect(local).toEqual({ openai: "sk-harness", "claude-acp": "claude-oauth", anthropic: "sk-ant-model" })

    const all = await resolveAllSecrets()
    expect(all).toEqual({ openai: "sk-harness", "claude-acp": "claude-oauth", anthropic: "sk-ant-model" })
  })
})
