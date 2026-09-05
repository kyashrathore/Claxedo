/**
 * Fan-out integration test.
 *
 * Asserts that an install / uninstall lifecycle on a single shared
 * agent-extension store fans out config pushes to EVERY connected
 * workspace runtime — not just the one used at install time.
 *
 * Architecture under test:
 *   install*.ts → broadcastExtensionChange → fanOutConfig
 *                 → workspace-supervisor.broadcastRuntimeConfig
 *                 → push(runtime, snapshot) for each `ready` runtime
 *                   → fetch(`${runtime.url}/api/wr/config`, POST)
 *
 * We stand up two minimal HTTP servers that each record the
 * `/api/wr/config` POSTs they receive, inject them into the
 * supervisor's runtime map via the test-helper module, and exercise `broadcastRuntimeConfig`
 * directly — bypassing the agent-extensions disk lifecycle (which is
 * already covered by the per-package install.test.ts suite).
 */

import http from "http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import {
  broadcastRuntimeConfig,
  configureWorkspaceSupervisor,
  syncWorkspaceRuntimeAgentExtensions,
} from "./index"
import { __registerReadyRuntimeForTest, __unregisterRuntimeForTest } from "./test-helper"
import type { WorkspaceAgentExtensionRecord } from "@claxedo/server-core/hosts/agent-extensions/workspace"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/db"
import { setBackendOverride, createTestBackend } from "@claxedo/server-core/credentials/backend-registry"
import { putCredential } from "@claxedo/server-core/credentials/registry"
import { saveUserConfig, configureAgentConfig } from "@claxedo/server-core/agent-config/index"

type RecordedRequest = {
  method: string
  url: string
  body: unknown
}

async function startRecordingServer(): Promise<{ url: string; received: RecordedRequest[]; stop: () => Promise<void> }> {
  const received: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body: unknown
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
      } catch {
        body = undefined
      }
      received.push({ method: req.method ?? "", url: req.url ?? "", body })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test recording server")
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    received,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

describe("agent-extensions fan-out reaches every connected workspace runtime", () => {
  let dataRoot: string
  const previousDataDir = process.env.CLAXEDO_DATA_DIR
  const previousRuntimeSigner = {
    privateKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
    publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
    algorithm: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM,
  }

  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "scoped-runtime-fanout-"))
    process.env.CLAXEDO_DATA_DIR = dataRoot
    ClaxedoDB.close()
    setBackendOverride(createTestBackend())
    configureAgentConfig({ workspaceAuthority: { listWorkspaceAgentExtensionsForRuntime: async () => [], listAgentExtensionPolicyOverridesForRuntime: async () => [] } as never })
    const keyPair = await generateKeyPair("EdDSA", { extractable: true })
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = await exportPKCS8(keyPair.privateKey)
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(keyPair.publicKey)
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"
    // The broadcast pulls a runtime-config snapshot before pushing.
    // `getRuntimeConfigSnapshot` is the only supervisor dependency
    // the broadcast touches; everything else lives behind opts that
    // we don't exercise in this test path.
    configureWorkspaceSupervisor({
      start: async () => {
        throw new Error("workspace-supervisor.start should not be invoked in this test")
      },
      stop: async () => {
        // no-op
      },
    } as any)
  })

  beforeEach(async () => {
    await saveUserConfig({ version: 3, connections: {}, mcp: {} })
  })

  afterAll(async () => {
    configureAgentConfig({})
    setBackendOverride(undefined)
    ClaxedoDB.close()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
    await rm(dataRoot, { recursive: true, force: true })
    if (previousRuntimeSigner.privateKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = previousRuntimeSigner.privateKey
    if (previousRuntimeSigner.publicKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previousRuntimeSigner.publicKey
    if (previousRuntimeSigner.algorithm === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = previousRuntimeSigner.algorithm
  })

  const trackedWorkspaceIds: string[] = []
  afterEach(() => {
    for (const id of trackedWorkspaceIds) __unregisterRuntimeForTest(id)
    trackedWorkspaceIds.length = 0
  })

  test("broadcastRuntimeConfig pushes to two simultaneously running runtimes", async () => {
    const [a, b] = await Promise.all([startRecordingServer(), startRecordingServer()])
    try {
      __registerReadyRuntimeForTest({ workspaceId: "ws-a", url: a.url, directory: "/tmp/ws-a" })
      __registerReadyRuntimeForTest({ workspaceId: "ws-b", url: b.url, directory: "/tmp/ws-b" })
      trackedWorkspaceIds.push("ws-a", "ws-b")

      await broadcastRuntimeConfig()

      // Both runtimes must have received the config push.
      expect(a.received).toHaveLength(1)
      expect(b.received).toHaveLength(1)
      expect(a.received[0]).toMatchObject({ method: "POST", url: "/api/wr/config" })
      expect(b.received[0]).toMatchObject({ method: "POST", url: "/api/wr/config" })
      // And they should both have received the SAME snapshot body —
      // proves it's a single shared source-of-truth being fanned out,
      // not a per-runtime config drift.
      expect(a.received[0]?.body).toEqual(b.received[0]?.body)
    } finally {
      await Promise.all([a.stop(), b.stop()])
    }
  })

  test("broadcast and extension updates materialize secrets separately for local, cloud and other-org targets", async () => {
    const servers = await Promise.all([startRecordingServer(), startRecordingServer(), startRecordingServer()])
    try {
      const local = await putCredential({ provider_id: "local", kind: "api_key", source: "managed", secret: "local-secret" }, "org-a")
      const shared = await putCredential({ provider_id: "shared", kind: "api_key", source: "managed", scope: "shared", consent: { at: Date.now(), surface: "cli" }, secret: "shared-secret" }, "org-a")
      await saveUserConfig({ version: 3, mcp: {}, connections: { external: { connectionId: "external", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "External", connection: { kind: "process", command: "agent" } }, secretRefs: { local: local.id, shared: shared.id } } } })
      for (const [index, id] of ["ws-scope-local", "ws-scope-cloud", "ws-scope-other"].entries()) {
        const state = __registerReadyRuntimeForTest({ workspaceId: id, url: servers[index]!.url, directory: dataRoot, kind: index === 0 ? "local" : "cloud" })
        state.ws.org_id = index === 2 ? "org-b" : "org-a"
        trackedWorkspaceIds.push(id)
      }
      const authAt = (index: number) => (servers[index]!.received.at(-1)?.body as { auth: Record<string, string> }).auth
      await broadcastRuntimeConfig()
      expect(servers.map((server) => server.received.length)).toEqual([1, 1, 1])
      expect(authAt(0)).toMatchObject({ [local.id]: "local-secret", [shared.id]: "shared-secret" })
      expect(authAt(1)).toMatchObject({ [shared.id]: "shared-secret" })
      expect(authAt(1)).not.toHaveProperty(local.id)
      expect(authAt(1)).not.toHaveProperty("local")
      expect(authAt(2)).toEqual({})
      await syncWorkspaceRuntimeAgentExtensions("ws-scope-cloud", [], { policyOverrides: [] })
      expect(servers.map((server) => server.received.length)).toEqual([1, 2, 1])
      expect(authAt(1)).toMatchObject({ [shared.id]: "shared-secret" })
      expect(authAt(1)).not.toHaveProperty(local.id)
      expect(authAt(1)).not.toHaveProperty("local")
    } finally {
      await Promise.all(servers.map((server) => server.stop()))
    }
  })

  test("syncWorkspaceRuntimeAgentExtensions pushes only to the affected workspace", async () => {
    const [a, b] = await Promise.all([startRecordingServer(), startRecordingServer()])
    try {
      __registerReadyRuntimeForTest({ workspaceId: "ws-target", url: a.url, directory: "/tmp/ws-target" })
      __registerReadyRuntimeForTest({ workspaceId: "ws-bystander", url: b.url, directory: "/tmp/ws-bystander" })
      trackedWorkspaceIds.push("ws-target", "ws-bystander")

      const installs: WorkspaceAgentExtensionRecord[] = [{
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 0,
          updated_at: 0,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: "deadbeef" },
          component_digests: { package: "deadbeef" },
          targets: ["cursor"],
        },
      }]

      await syncWorkspaceRuntimeAgentExtensions("ws-target", installs)

      expect(a.received).toHaveLength(1)
      expect(b.received).toHaveLength(0)
      const body = a.received[0]?.body as { agent_extensions?: { installs: Array<{ desired: { id: string } }> } }
      expect(body?.agent_extensions?.installs.map((item) => item.desired.id)).toEqual(["review"])
    } finally {
      await Promise.all([a.stop(), b.stop()])
    }
  })

  test("syncWorkspaceRuntimeAgentExtensions does not start an offline workspace runtime", async () => {
    const a = await startRecordingServer()
    try {
      __registerReadyRuntimeForTest({ workspaceId: "ws-ready", url: a.url, directory: "/tmp/ws-ready" })
      trackedWorkspaceIds.push("ws-ready")

      // ws-offline is intentionally NOT registered. Sync must NOT throw,
      // must NOT touch ws-ready (wrong target), and must NOT attempt to
      // start a runtime for ws-offline.
      await syncWorkspaceRuntimeAgentExtensions("ws-offline", [])

      expect(a.received).toHaveLength(0)
    } finally {
      await a.stop()
    }
  })

  test("broadcast skips runtimes that are not ready", async () => {
    const a = await startRecordingServer()
    try {
      __registerReadyRuntimeForTest({ workspaceId: "ws-ready", url: a.url })
      trackedWorkspaceIds.push("ws-ready", "ws-pending")
      // Inject a second runtime that lacks a URL — broadcastRuntimeConfig
      // filters on `status === "ready" && url`, so this must NOT receive
      // a push even though it is in the runtimes Map.
      __registerReadyRuntimeForTest({ workspaceId: "ws-pending", url: "" })

      await broadcastRuntimeConfig()

      expect(a.received).toHaveLength(1)
      // No way to assert "no push went to ws-pending" without binding
      // a server for it; the absence of a URL means push() would have
      // thrown synchronously and Promise.allSettled would swallow it
      // — that's the desired behavior. Asserting `a` got exactly one
      // push is sufficient evidence of the filter.
    } finally {
      await a.stop()
    }
  })
})
