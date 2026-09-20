import { afterEach, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { configureAgentConfig, disposeAgentConfig } from "@claxedo/server-core/agent-config/index"
import { createTestBackend, setBackendOverride } from "@claxedo/server-core/credentials/backend-registry"
import { putCredential, setActiveCredentials } from "@claxedo/server-core/credentials/registry"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { createLocalCredentialBroker } from "../../credentials/broker"
import { ensureEmbeddedWorkspaceRuntime, shutdownEmbeddedWorkspaceRuntimes } from "./embedded-workspace-runtime"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
let roots: string[] = []

afterEach(async () => {
  await shutdownEmbeddedWorkspaceRuntimes()
  disposeAgentConfig()
  setBackendOverride(undefined)
  ClaxedoDB.close()
  closeAuthorityDatabases()
  for (const root of roots) await fs.rm(root, { recursive: true, force: true })
  roots = []
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

/**
 * A real workspace whose credentials come from the real local broker, reading a
 * clock this test moves. Every proxied POST syncs config through this path.
 */
async function workspaceOnRealBroker(clock: () => number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "embedded-projection-stability-"))
  roots.push(root)
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  setBackendOverride(createTestBackend())
  const credential = await putCredential({
    provider_id: "claude-sdk",
    kind: "api_key",
    source: "managed",
    account_id: "acc-stability",
    secret: "sk-ant-api03-stability",
  })
  expect(setActiveCredentials([credential.id])).toMatchObject({ ok: true })
  const broker = createLocalCredentialBroker({
    dataDir: path.join(root, "data"),
    brokerOrigin: "http://127.0.0.1:2595",
    now: clock,
  })
  configureAgentConfig({ projectAuth: (input) => broker.projectAuth(input) })
  const workspace: Workspace = {
    id: "ws_projection_stability",
    directory: project,
    kind: "local",
    created_at: 1,
    updated_at: 1,
  }
  return workspace
}

/**
 * A config sync is what every dispatched POST does on its way in, and an apply
 * that finds the snapshot moved restarts the harness processes under it. A
 * session Pi or Codex has not written a file for yet does not survive that, so
 * an unchanged credential must produce a byte-identical snapshot no matter how
 * much wall clock passed between the two requests.
 */
test("two config syncs a second apart over the real broker apply once", async () => {
  let clock = Date.now()
  const workspace = await workspaceOnRealBroker(() => clock)

  const first = await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })
  expect(first.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })

  clock += 1_000
  const second = await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })
  clock += 29 * 60_000
  const third = await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })

  expect(second.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })
  expect(third.host.detail().configApply).toMatchObject({ state: "applied", revision: 1 })
})

test("a placeholder past half its life reaches the runtime as a new apply", async () => {
  let clock = Date.now()
  const workspace = await workspaceOnRealBroker(() => clock)

  await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })
  clock += 31 * 60_000
  const renewed = await ensureEmbeddedWorkspaceRuntime(workspace, { config: "sync" })

  expect(renewed.host.detail().configApply).toMatchObject({ state: "applied", revision: 2 })
})
