import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { getRuntimeConfigSnapshot, projectRuntimeAuth } from "@claxedo/server-core/agent-config/index"
import { createTestBackend, setBackendOverride } from "@claxedo/server-core/credentials/backend-registry"
import { putCredential, setActiveCredentials } from "@claxedo/server-core/credentials/registry"
import { providerProjection } from "@claxedo/agent-sdk-runtime"
import { clearHostProviderConfig } from "../workspace/host-provider-config"
import { startLocalServer, type LocalServer } from "./start-local-server"

/**
 * The pushed rows reach a turn through the one seam every harness launch
 * reads — the runtime config snapshot's `auth` — and they are written over
 * what this machine's own credential broker would have answered for the same
 * provider. A provider the owner did not push keeps the machine's answer.
 */

let dataDir: string
let previousDataDir: string | undefined
let server: LocalServer | undefined
let origin: string

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })
}

const PUSHED = { baseUrl: "https://broker.owner.test/bindings/owner-1", placeholder: "sk-owner-placeholder", authMode: "api-key" as const }

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-host-provider-config-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  setBackendOverride(createTestBackend())
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = startLocalServer({ port })
  await server.ready
})

afterEach(async () => {
  clearHostProviderConfig()
  await server?.stop()
  server = undefined
  setBackendOverride(undefined)
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function machineHolds(providerId: string) {
  const credential = await putCredential({
    provider_id: providerId,
    kind: "api_key",
    source: "managed",
    account_id: `acc-${providerId}`,
    secret: `sk-machine-${providerId}`,
  })
  expect(setActiveCredentials([credential.id])).toMatchObject({ ok: true })
}

async function push(revision: number, providers: Record<string, unknown>) {
  return fetch(`${origin}/api/claxedo/host-provider-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, providers: JSON.stringify({ version: 1, providers }) }),
  })
}

describe("a workspace on this machine resolves the owner's pushed provider", () => {
  test("ahead of the machine's own broker answer, and only for the provider the owner named", async () => {
    await machineHolds("claude-sdk")
    await machineHolds("codex")
    const before = await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" })
    const machineRow = providerProjection(before["claude-sdk"], {})
    if (!machineRow || "unavailable" in machineRow) throw new Error("expected the broker to bind the machine's own credential")
    expect(machineRow.baseUrl).toContain(`${origin}/bindings/`)

    const response = await push(1, { "claude-sdk": PUSHED })
    expect(response.status).toBe(200)

    const snapshot = await getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })
    expect(snapshot.auth["claude-sdk"]).toEqual(PUSHED)
    expect(providerProjection(snapshot.auth.codex, {})).toEqual(providerProjection(before.codex, {}))
    expect(JSON.stringify(snapshot.auth)).not.toContain("sk-machine-claude-sdk")
  })

  test("a withdrawal hands the provider back to the machine's own answer", async () => {
    await machineHolds("claude-sdk")
    await push(1, { "claude-sdk": PUSHED })
    expect((await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" }))["claude-sdk"]).toEqual(PUSHED)

    expect((await push(2, {})).status).toBe(200)

    const after = providerProjection((await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" }))["claude-sdk"], {})
    if (!after || "unavailable" in after) throw new Error("expected the broker's own binding back")
    expect(after.baseUrl).toContain(`${origin}/bindings/`)
  })

  test("a revision with one unreadable row leaves the previous rows answering", async () => {
    await push(1, { "claude-sdk": PUSHED })

    const refused = await push(2, { "claude-sdk": PUSHED, codex: { baseUrl: "https://x", authMode: "bearer" } })

    expect(refused.status).toBe(400)
    expect(await projectRuntimeAuth({ scope: "local", workspaceId: "ws_1" })).toEqual({ "claude-sdk": PUSHED })
    expect(await (await fetch(`${origin}/api/claxedo/host-provider-config`)).json()).toEqual({ revision: 1, providerCount: 1 })
  })
})
