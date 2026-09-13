import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createWorkspaceHost } from "@claxedo/workspace-runtime/host"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-secret-scope-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { putCredential, updateCredentialStatus } = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
const { getRuntimeConfigSnapshot, saveUserConfig, configureAgentConfig } = await import("@claxedo/server-core/agent-config/index")

describe("runtime config secret scoping", () => {
  beforeEach(async () => {
    configureAgentConfig({})
    // Close BEFORE the rm: the previous test's claxedo.db handle is still
    // open here, and Windows answers an unlink of an open file with EBUSY.
    // The retries absorb the brief lock Windows keeps even after close.
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    await fs.mkdir(root, { recursive: true })
    setBackendOverride(createTestBackend())
    ClaxedoDB.Drizzle()
  })

  afterAll(async () => {
    configureAgentConfig({})
    setBackendOverride(undefined)
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  /**
   * A runtime snapshot has no plaintext credential channel at all: not the user
   * config file, not a registry secret resolved by scope, not a connection's
   * `secretRefs`. Everything a harness gets comes from the installed credential
   * authority, as a placeholder.
   */
  test("no runtime snapshot carries credential material, in either scope", async () => {
    const put = (name: string, extra: object = {}, org = "org-a") => putCredential({
      provider_id: name, kind: "api_key", source: "managed", secret: `${name}-secret`,
      scope: "shared", consent: { at: Date.now(), surface: "cli" }, ...extra,
    }, org)
    const shared = await put("shared-account")
    await put("local-account", { scope: "local", consent: undefined })
    const revoked = await put("revoked-account")
    await updateCredentialStatus(revoked.id, "revoked", undefined, "org-a")
    await saveUserConfig({
      version: 3,
      mcp: {},
      connections: {
        external: {
          connectionId: "external",
          providerKey: "acp",
          configRevision: 1,
          enabled: true,
          config: { label: "external", connection: { kind: "process", command: "agent" } },
          secretRefs: { token: shared.id },
        },
      },
    })

    const sharedSnapshot = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared", orgId: "org-a" })
    const localSnapshot = await getRuntimeConfigSnapshot(undefined, { orgId: "org-a" })

    expect(sharedSnapshot.auth).toEqual({})
    expect(localSnapshot.auth).toEqual({})
    // The descriptor still names its references; an id is not secret material.
    expect(JSON.stringify([sharedSnapshot, localSnapshot])).not.toContain("-secret")

    // A descriptor that still names secret references has no source in a v4
    // snapshot, so selecting it fails closed rather than starting unauthenticated.
    const host = createWorkspaceHost({ target: { workspaceId: "ws-denied", directory: root }, storeRoot: path.join(root, "denied") })
    try {
      await expect(host.apply({
        ...localSnapshot,
        defaultHarness: { kind: "connection", connectionId: "external" },
      })).rejects.toThrow()
    } finally {
      await host.dispose()
    }
  })

  test("the snapshot carries exactly what the installed authority projects", async () => {
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/c41e",
      placeholder: "signed-placeholder",
      authMode: "bearer" as const,
      expiresAt: 1_800_000_000_000,
    }
    await saveUserConfig({ version: 3, mcp: {}, connections: {} })
    configureAgentConfig({
      projectAuth: async ({ scope }): Promise<Record<string, typeof projection>> =>
        scope === "local" ? { "claude-sdk": projection } : {},
    })

    expect((await getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })).auth)
      .toEqual({ "claude-sdk": projection })
    expect((await getRuntimeConfigSnapshot(undefined, { secretScope: "shared", workspaceId: "ws_1" })).auth)
      .toEqual({})
  })

  test("shared runtime snapshots exclude local-only MCP overlays", async () => {
    await saveUserConfig({
      version: 3,
      connections: {},
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
