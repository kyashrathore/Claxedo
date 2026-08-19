/**
 * The self-hosted composition contributing WorkGraph routes to a LOCAL runtime.
 *
 * This case lives here, not beside the embedded runtime, because it is about
 * `selfHostedCapabilities` — which reaches `@claxedo/workgraph`, hosted surface
 * that `@claxedo/local-server` must never close over. The runtime itself is
 * imported through the package boundary, exactly as the self-hosted server
 * composes it.
 */

import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
} from "@claxedo/local-server/deployments/local/embedded-workspace-runtime"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { selfHostedCapabilities } from "./capabilities"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const previousAgentType = process.env.CLAXEDO_AGENT_TYPE

afterEach(() => {
  shutdownEmbeddedWorkspaceRuntimes()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  if (previousAgentType === undefined) delete process.env.CLAXEDO_AGENT_TYPE
  else process.env.CLAXEDO_AGENT_TYPE = previousAgentType
})

async function makeWorkspaceRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const project = path.join(root, "project")
  await fs.mkdir(project, { recursive: true })
  return { root, project }
}

function workspace(id: string, directory: string): Workspace {
  return {
    id,
    directory,
    kind: "local",
    created_at: Date.now(),
    updated_at: Date.now(),
  } as Workspace
}

describe("self-hosted runtime contributions", () => {
  test("mounts the WorkGraph Run routes only when a host contributes them", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-run-broker-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "pi"

    try {
      configureEmbeddedWorkspaceRuntime({
        opencodeRequest: async () => new Response(null, { status: 404 }),
        routeContributions: selfHostedCapabilities({
          workGraphRunBroker: async () => {
            throw new Error("not invoked while binding")
          },
          workGraphConnectionBroker: async () => {
            throw new Error("not invoked while binding")
          },
        }).runtimeRouteContributions,
      })
      const ws = workspace("ws_run_broker", project)
      const runtime = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const query = `directory=${encodeURIComponent(project)}&runner=pi`
      const created = await runtime.app.request(`http://localhost/session?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Managed Run" }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const session = await created.json() as { id: string }
      const bound = await runtime.app.request(`http://localhost/api/workgraph/run-binding?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          identity: {
            runId: "run-1",
            sessionId: session.id,
            workspaceId: ws.id,
            generation: 1,
          },
          harness: "pi",
          brokerUrl: "http://127.0.0.1",
        }),
      })
      expect(bound.status, await bound.clone().text()).toBe(200)
    } finally {
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      shutdownEmbeddedWorkspaceRuntimes()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  // The Unit 2 acceptance criterion, and the half that was previously
  // untestable: with no contributed capability the route does not exist. A
  // runtime flag could only have made it refuse.
})
