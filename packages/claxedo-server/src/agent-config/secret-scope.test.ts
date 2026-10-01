import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createWorkspaceHost } from "@claxedo/workspace-runtime/host"
import { loopbackMachineLoginPolicy } from "@claxedo/workspace-runtime/testing"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-secret-scope-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { createTestBackend, setBackendOverride } = await import("@claxedo/server-core/credentials/backend-registry")
const { putCredential, setActiveCredentials, updateCredentialStatus } = await import("@claxedo/server-core/credentials/registry")
const { ClaxedoDB } = await import("../platform/db")
const { getRuntimeConfigSnapshot, saveUserConfig, configureAgentConfig } = await import("@claxedo/server-core/agent-config/index")
const { selfHostedCredentialAuthority } = await import("../deployments/self-hosted-node/app")

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
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  /**
   * A runtime snapshot has no plaintext credential channel at all: not the user
   * config file, not a registry secret resolved by scope, not a connection's
   * `secretRefs`. Everything a harness gets comes from the installed credential
   * authority, as a placeholder.
   */
  test("no runtime snapshot carries credential material, in either scope", async () => {
    const put = (name: string, extra: object = {}, org = "org-a") => putCredential({ owner: "local",
      provider_id: name, kind: "api_key", source: "managed", secret: `${name}-secret`,
      scope: "shared", consent: { at: Date.now(), surface: "cli" }, ...extra,
    }, org)
    const shared = await put("shared-account")
    await put("local-account", { scope: "local", consent: undefined })
    const revoked = await put("revoked-account")
    await updateCredentialStatus(revoked.id, "revoked", undefined, "org-a")
    await saveUserConfig({
      version: 3,
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

    const sharedSnapshot = await getRuntimeConfigSnapshot({ secretScope: "shared", orgId: "org-a" })
    const localSnapshot = await getRuntimeConfigSnapshot({ orgId: "org-a" })

    expect(sharedSnapshot.auth).toEqual({ machineOwnerUserId: "", accounts: {} })
    expect(localSnapshot.auth).toEqual({ machineOwnerUserId: "", accounts: {} })
    // The descriptor still names its references; an id is not secret material.
    expect(JSON.stringify([sharedSnapshot, localSnapshot])).not.toContain("-secret")

    // A descriptor that still names secret references has no source in a v4
    // snapshot, so selecting it fails closed rather than starting unauthenticated.
    const host = createWorkspaceHost({
    sessionIdWorkspace: () => undefined, target: { workspaceId: "ws-denied", directory: root }, storeRoot: path.join(root, "denied"), placement: loopbackMachineLoginPolicy() })
    try {
      await expect(host.apply({
        ...localSnapshot,
        defaultHarness: { kind: "connection", connectionId: "external" },
      })).rejects.toThrow()
    } finally {
      await host.dispose()
    }
  })

  test("the snapshot carries exactly what the installed authority projects for the caller's scope, org, workspace and sandbox", async () => {
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/c41e",
      placeholder: "signed-placeholder",
      authMode: "bearer" as const,
      expiresAt: 1_800_000_000_000,
    }
    const calls: unknown[] = []
    await saveUserConfig({ version: 3, connections: {} })
    configureAgentConfig({
      projectAuth: async (input): Promise<import("@claxedo/agent-runtime-contract").CredentialSnapshot<typeof projection>> => {
        calls.push(input)
        return { machineOwnerUserId: "local", accounts: { local: input.scope === "local" ? { "claude-sdk": projection } : {} } }
      },
    })

    const local = await getRuntimeConfigSnapshot({ orgId: "org-a", workspaceId: "ws_1", secretBrokering: "native" })
    const shared = await getRuntimeConfigSnapshot({ secretScope: "shared", orgId: "org-b", workspaceId: "ws_2", secretBrokering: "none" })

    expect(local.auth.accounts.local).toEqual({ "claude-sdk": projection })
    expect(shared.auth.accounts.local).toEqual({})
    expect(calls).toEqual([
      { scope: "local", orgId: "org-a", workspaceId: "ws_1", secretBrokering: "native" },
      { scope: "shared", orgId: "org-b", workspaceId: "ws_2", secretBrokering: "none" },
    ])
  })

  test("the self-hosted authority projects an org's marked account to that org's sandboxes and to no other org", async () => {
    const marked = await putCredential({ owner: "local",
      provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "sk-ant-api03-org-a",
      scope: "shared", consent: { at: Date.now(), surface: "cli" },
    }, "org-a")
    expect(setActiveCredentials([marked.id], "org-a", "local")).toMatchObject({ ok: true })
    await saveUserConfig({ version: 3, connections: {} })
    configureAgentConfig({ projectAuth: selfHostedCredentialAuthority() })

    const own = await getRuntimeConfigSnapshot({ secretScope: "shared", orgId: "org-a", workspaceId: "ws_1", secretBrokering: "native", sandboxOwner: "local" })
    const foreign = await getRuntimeConfigSnapshot({ secretScope: "shared", orgId: "org-b", workspaceId: "ws_2", secretBrokering: "native", sandboxOwner: "local" })

    expect(own.auth.accounts.local).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: expect.stringMatching(/^CLAXEDO_PROVIDER_CLAUDE_SDK_[0-9A-F]{24}$/),
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
    expect(foreign.auth.accounts).toEqual({})
    expect(JSON.stringify([own, foreign])).not.toContain("sk-ant-")
  })

})
