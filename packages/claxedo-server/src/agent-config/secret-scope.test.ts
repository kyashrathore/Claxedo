import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Hono } from "hono"
import { NO_HARNESS_EFFORT, type ConnectionProvider } from "@claxedo/agent-sdk-runtime"
import { sessionIdle } from "@claxedo/agent-sdk-runtime/compat-events"
import { createWorkspaceHost } from "@claxedo/workspace-runtime/host"
import { loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import { withWorkspaceTarget } from "../../../workspace-runtime/src/target"

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

  test("exact credential IDs survive the producer, runtime config, public create and prompt", async () => {
    const writes = ["first", "second"] as const
    const credentials = await Promise.all(writes.map((account) => putCredential({ provider_id: "external", account_id: account, kind: "api_key", source: "managed", scope: "shared", consent: { at: Date.now(), surface: "cli" }, secret: `${account}-secret` }, "org-a")))
    const used: Array<Readonly<Record<string, string>>> = []
    const capabilities = { abort: false, reconnect: false, replay: true, permissions: false, questions: false, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: false, subagents: false }
    const provider: ConnectionProvider<unknown, Readonly<Record<string, string>>> = {
      providerKey: "fixture",
      validateConfig: (config) => config,
      project: () => ({ label: "Fixture", readiness: "ready", capabilities }),
      resolve: ({ secrets }) => ({ config: secrets }),
      createAdapter: ({ resolved }) => ({
        sessionConfigOwner: "runtime",
        async *executeTurn(input) { used.push(resolved.config as Record<string, string>); yield sessionIdle(input.sessionId) },
        async createSession(_directory, _title, id) { return { id: id! } },
        instructionChannel: "none" as const,
        async getSession(binding) { return { id: binding.sessionId } },
        async updateSession(binding) { return { id: binding.sessionId } },
        async deleteSession() {},
        async getSessionConfig() { throw new Error("runtime owns config") },
        async updateSessionConfig() { throw new Error("runtime owns config") },
        async getMessages() { return [] },
        readHarnessCapabilities: () => ({
          ...capabilities,
          goals: false,
          harness: "fixture",
          effortLevels: NO_HARNESS_EFFORT,
          instructionChannel: "none" as const,
        }),
        dispose() {},
      }),
    }
    configureAgentConfig({ connectionProviders: [provider] })
    await saveUserConfig({ version: 3, mcp: {}, connections: { external: { connectionId: "external", providerKey: "fixture", configRevision: 1, enabled: true, config: {}, secretRefs: { first: credentials[0].id, second: credentials[1].id } } } })
    const snapshot = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared", orgId: "org-a" })
    expect(snapshot.auth).toMatchObject({ [credentials[0].id]: "first-secret", [credentials[1].id]: "second-secret", external: expect.any(String) })
    const target = { workspaceId: "ws-credentials", directory: root }
    const host = createWorkspaceHost({ target, storeRoot: path.join(root, "runtime"), connectionProviders: [provider] })
    const app = new Hono()
    host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
    const request = (url: string, body: object) => withWorkspaceTarget(target, () => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
    try {
      await host.apply(snapshot)
      const created = await request("/session?connectionId=external", { id: "session-credentials", title: "Credentials" })
      expect(created.status, await created.clone().text()).toBe(201)
      const prompted = await request("/session/session-credentials/message", { parts: [{ type: "text", text: "Hello" }] })
      expect(prompted.status, await prompted.clone().text()).toBe(200)
      await prompted.text()
      expect(used).toEqual([{ first: "first-secret", second: "second-secret" }])
    } finally {
      await host.dispose()
    }
  })

  test("connection snapshots omit revoked, expired, missing, unshared, disabled and foreign-org references", async () => {
    const backend = createTestBackend()
    setBackendOverride(backend)
    const put = (name: string, extra: object = {}, org = "org-a") => putCredential({ provider_id: name, kind: "api_key", source: "managed", secret: `${name}-secret`, scope: "shared", consent: { at: Date.now(), surface: "cli" }, ...extra }, org)
    const good = await put("good")
    const revoked = await put("revoked")
    await updateCredentialStatus(revoked.id, "revoked", undefined, "org-a")
    const expired = await put("expired", { expires_at: Date.now() - 1 })
    const missing = await put("missing")
    await backend.delete(missing.secure_ref!)
    const local = await put("local", { scope: "local", consent: undefined })
    const foreign = await put("foreign", {}, "org-b")
    const disabled = await put("disabled")
    const connection = (id: string, references: Record<string, string>, enabled = true) => ({ connectionId: id, providerKey: "acp", configRevision: 1, enabled, config: { label: id, connection: { kind: "process", command: "agent" } }, secretRefs: references })
    await saveUserConfig({ version: 3, mcp: {}, connections: {
      active: connection("active", { good: good.id, revoked: revoked.id, expired: expired.id, missing: missing.id, local: local.id, foreign: foreign.id, absent: "missing-id" }),
      disabled: connection("disabled", { disabled: disabled.id }, false),
    }, auth: { [revoked.id]: "untrusted-config-value" } })
    const shared = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared", orgId: "org-a" })
    expect(shared.auth[good.id]).toBe("good-secret")
    for (const id of [revoked.id, expired.id, missing.id, local.id, foreign.id, disabled.id, "missing-id"]) expect(shared.auth).not.toHaveProperty(id)
    expect(shared.auth).not.toHaveProperty("expired")
    const localSnapshot = await getRuntimeConfigSnapshot(undefined, { orgId: "org-a" })
    expect(localSnapshot.auth[local.id]).toBe("local-secret")
    expect(localSnapshot.auth).not.toHaveProperty(revoked.id)
    const otherOrg = await getRuntimeConfigSnapshot(undefined, { secretScope: "shared", orgId: "org-b" })
    expect(otherOrg.auth[foreign.id]).toBe("foreign-secret")
    expect(otherOrg.auth).not.toHaveProperty(good.id)
    expect(otherOrg.auth).not.toHaveProperty("good")
    const host = createWorkspaceHost({ target: { workspaceId: "ws-denied", directory: root }, storeRoot: path.join(root, "denied") })
    try {
      await expect(host.apply({ ...shared, defaultHarness: { kind: "connection", connectionId: "active" } })).rejects.toThrow()
    } finally {
      await host.dispose()
    }
  })

  test("shared runtime snapshots exclude legacy and local-only credential secrets", async () => {
    await saveUserConfig({
      version: 3,
      mcp: {},
      connections: {},
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
      version: 3,
      auth: {},
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
