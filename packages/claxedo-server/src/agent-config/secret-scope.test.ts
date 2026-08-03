import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-secret-scope-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("../credentials/store")
const { putCredential } = await import("../credentials/registry")
const { ClaxedoDB } = await import("../platform/db/db")
const { getRuntimeConfigSnapshot, saveUserConfig } = await import("./index")

describe("runtime config secret scoping", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
    setBackendOverride(createTestBackend())
    ClaxedoDB.close()
    ClaxedoDB.Drizzle()
  })

  afterAll(async () => {
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("shared runtime snapshots exclude legacy and local-only credential secrets", async () => {
    await saveUserConfig({
      mcp: {},
      auth: {
        legacy: "legacy-local-secret",
      },
    })
    // Since the 2026-07-29 scope-policy change, a managed SOURCE alone no
    // longer reaches shared snapshots — sharing is an explicit, consented
    // scope decision recorded on the credential.
    await putCredential({
      provider_id: "managed-provider",
      kind: "api_key",
      source: "managed",
      scope: "shared",
      consent: { at: Date.now(), surface: "scope_change" },
      secret: "managed-secret",
    })
    await putCredential({
      provider_id: "local-provider",
      kind: "api_key",
      source: "local_only",
      secret: "local-secret",
    })
    await putCredential({
      provider_id: "env-provider",
      kind: "api_key",
      source: "env",
      secret: "env-secret",
    })
    await putCredential({
      provider_id: "upstream-provider",
      kind: "oauth_token",
      source: "upstream_sync",
      secret: "upstream-secret",
    })

    const shared = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared" })
    expect(shared.auth).toEqual({
      "managed-provider": "managed-secret",
    })

    const local = await getRuntimeConfigSnapshot(undefined, { secretScope: "local" })
    expect(local.auth).toMatchObject({
      legacy: "legacy-local-secret",
      "managed-provider": "managed-secret",
      "local-provider": "local-secret",
      "env-provider": "env-secret",
      "upstream-provider": "upstream-secret",
    })
  })

  test("shared runtime snapshots exclude local-only MCP overlays", async () => {
    await saveUserConfig({
      auth: {},
      runner: { type: "claude-acp" },
      mcp: {
        "local-stdio": {
          type: "stdio",
          command: "node",
          args: ["local.js"],
          env: { LOCAL_SECRET: "local-secret" },
        },
        "local-remote": {
          type: "remote",
          url: "https://mcp.example.test",
          headers: { Authorization: "Bearer local-secret" },
        },
      },
    })

    const shared = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared" })
    expect(shared.mcp["local-stdio"]).toBeUndefined()
    expect(shared.mcp["local-remote"]).toBeUndefined()

    const local = await getRuntimeConfigSnapshot(undefined, { secretScope: "local" })
    expect(local.mcp["local-stdio"]).toMatchObject({
      source: "user",
      env: { LOCAL_SECRET: "local-secret" },
    })
    expect(local.mcp["local-remote"]).toMatchObject({
      source: "user",
      headers: { Authorization: "Bearer local-secret" },
    })
  })
})
