import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  verifyEmbeddedRuntimeCredential,
} from "./embedded-workspace-runtime"
import { disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { createRuntimeCredentialIssuer } from "@claxedo/workspace-runtime"
import { createAcpConnectionProvider } from "@claxedo/agent-sdk-runtime"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const roots: string[] = []

async function workspaceIn(prefix: string, id: string): Promise<Workspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  const directory = path.join(root, "project")
  await fs.mkdir(directory, { recursive: true })
  return { id, directory, kind: "local", created_at: 1, updated_at: 1 }
}

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig()
  ClaxedoDB.close()
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

describe("embedded first-party MCP credential", () => {
  test("each embedded runtime mints its own credential under the configured origin and the process verifies by workspace", async () => {
    const a = await workspaceIn("embedded-first-party-a-", "ws_first_party_a")
    const b = await workspaceIn("embedded-first-party-b-", "ws_first_party_b")
    process.env.CLAXEDO_DATA_DIR = path.join(path.dirname(a.directory), "data")
    configureEmbeddedWorkspaceRuntime({
      connectionProviders: [createAcpConnectionProvider()],
      firstPartyMcpLaunch: { baseUrl: "http://127.0.0.1:2593", userId: "user-1", enabledToolGroups: () => ["sessions"] },
    })

    const runtimeA = await ensureEmbeddedWorkspaceRuntime(a, { config: "skip" })
    const runtimeB = await ensureEmbeddedWorkspaceRuntime(b, { config: "skip" })
    const issuerA = runtimeA.host.runtimeCredentialIssuer()
    const issuerB = runtimeB.host.runtimeCredentialIssuer()
    expect(issuerA).toBeDefined()
    expect(issuerB).toBeDefined()
    expect(issuerA).not.toBe(issuerB)

    const tokenA = issuerA!.current()
    expect(verifyEmbeddedRuntimeCredential(tokenA)).toMatchObject({ workspaceId: "ws_first_party_a", userId: "user-1" })
    expect(verifyEmbeddedRuntimeCredential(issuerB!.current())).toMatchObject({ workspaceId: "ws_first_party_b" })
    expect(verifyEmbeddedRuntimeCredential(tokenA)?.runtimeId).not.toBe(verifyEmbeddedRuntimeCredential(issuerB!.current())?.runtimeId)

    const foreign = createRuntimeCredentialIssuer({ runtimeId: "elsewhere", workspaceId: "ws_first_party_a" })
    expect(verifyEmbeddedRuntimeCredential(foreign.current())).toBeUndefined()
    const unhosted = createRuntimeCredentialIssuer({ runtimeId: "elsewhere", workspaceId: "ws_not_hosted" })
    expect(verifyEmbeddedRuntimeCredential(unhosted.current())).toBeUndefined()
    expect(verifyEmbeddedRuntimeCredential("garbage")).toBeUndefined()
  })

  test("a process configured without the launch origin injects nothing and verifies nothing", async () => {
    const ws = await workspaceIn("embedded-first-party-off-", "ws_first_party_off")
    process.env.CLAXEDO_DATA_DIR = path.join(path.dirname(ws.directory), "data")
    configureEmbeddedWorkspaceRuntime({ connectionProviders: [createAcpConnectionProvider()] })
    const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
    expect(runtime.host.runtimeCredentialIssuer()).toBeUndefined()
    const stray = createRuntimeCredentialIssuer({ runtimeId: "stray", workspaceId: "ws_first_party_off" })
    expect(verifyEmbeddedRuntimeCredential(stray.current())).toBeUndefined()
  })
})
