import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { stopHostServing } from "@claxedo/host-serving/serving"
import { startLocalServer, type LocalServer } from "./start-local-server"
import {
  onEmbeddedWorkspaceRuntime,
  type EmbeddedWorkspaceRuntimePhase,
} from "../deployments/local/embedded-workspace-runtime"

// Turning remote access on dials the relay, and this file is about what
// happens to the runtimes rather than to the socket; a real dial would leave a
// reconnect loop behind every test.
vi.mock("@claxedo/workspace-runtime/relay", async (importOriginal) => ({
  ...await importOriginal<typeof import("@claxedo/workspace-runtime/relay")>(),
  hostTunnelPreOpenQueueFromEnv: () => ({}),
  startWorkspaceRelayHostTunnel: (options: { onEvent: (event: { type: string }) => void }) => {
    options.onEvent({ type: "connecting" })
    return { close: () => {}, updateRegistration: async () => {} }
  },
}))

/**
 * Remote access is a switch on the relay connection, never on the work.
 *
 * Publishing a machine, unpublishing it and signing out all reach the daemon
 * as the same one route: a serving credential, or none. A turn that is running
 * and a terminal that is open belong to the user at the keyboard, who did not
 * ask for either to end — so the composition disposes no runtime here, and the
 * declaration the connector carries changes with none of it.
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

function servingCredential(workspaceId: string) {
  return {
    credential: {
      hostId: "host_machine-1",
      enrollmentId: "enr_this_machine",
      relayUrl: "https://relay.claxedo.test",
      hostTunnelToken: "host-tunnel-token-value",
      tokenExpiresAt: Date.now() + 300_000,
      jti: "jti-1",
      workspaceIds: [workspaceId],
    },
    endpoints: { sessionAuthorityUrl: "https://cp.claxedo.test/api/runtime-authority/session-authorize" },
  }
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-desktop-serving-"))
  previousDataDir = process.env.CLAXEDO_DATA_DIR
  process.env.CLAXEDO_DATA_DIR = dataDir
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  server = startLocalServer({ port })
  await server.ready
})

afterEach(async () => {
  stopHostServing()
  await server?.stop()
  server = undefined
  ClaxedoDB.close()
  closeAuthorityDatabases()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function mountedWorkspace() {
  const directory = path.join(dataDir, "project")
  mkdirSync(directory)
  execFileSync("git", ["init", directory])
  const resolved = await fetch(
    `${origin}/api/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
  )
  const { workspaceId } = await resolved.json() as { workspaceId: string }
  // Any runtime-owned read mounts the workspace's runtime in process.
  const health = await fetch(`${origin}/workspaces/${workspaceId}/api/wr/health`)
  expect(health.status).toBe(200)
  return workspaceId
}

describe("turning remote access on and off", () => {
  test("disposes no runtime, on either edge", async () => {
    const workspaceId = await mountedWorkspace()
    const phases: EmbeddedWorkspaceRuntimePhase[] = []
    const stop = onEmbeddedWorkspaceRuntime((_runtime, phase) => { phases.push(phase) })
    try {
      // The replay of what is already mounted; everything after it is caused
      // by the two PUTs below.
      expect(phases).toEqual(["mounted"])
      phases.length = 0

      const enable = await fetch(`${origin}/api/claxedo/host-serving`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(servingCredential(workspaceId)),
      })
      const disable = await fetch(`${origin}/api/claxedo/host-serving`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: null }),
      })

      expect(enable.status).toBe(200)
      expect(await enable.json()).toMatchObject({ serving: true })
      expect(disable.status).toBe(200)
      expect(await disable.json()).toMatchObject({ serving: false })
      expect(phases).toEqual([])
      const health = await fetch(`${origin}/workspaces/${workspaceId}/api/wr/health`)
      expect(health.status).toBe(200)
    } finally {
      stop()
    }
  })

  /**
   * The wire a client takes to a workspace is its own answer to "is the
   * machine this row names me", and this declaration is the only thing that
   * ties a control-plane row to the server the client is already talking to.
   * It follows the credential rather than the enrollment: a signed-out machine
   * pushes `credential: null` and must stop claiming to be that machine.
   */
  test("the bootstrap declares the serving machine's enrollment, and nothing before or after it serves", async () => {
    const workspaceId = await mountedWorkspace()
    const enrollment = async () =>
      ((await (await fetch(`${origin}/api/claxedo/bootstrap`)).json()) as { host?: { enrollment?: string | null } }).host?.enrollment

    expect(await enrollment()).toBeNull()

    await fetch(`${origin}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(servingCredential(workspaceId)),
    })
    expect(await enrollment()).toBe("enr_this_machine")

    await fetch(`${origin}/api/claxedo/host-serving`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: null }),
    })
    expect(await enrollment()).toBeNull()
  })

  test("declares managed-private to the control plane while the catalog keeps telling this window it reserves nothing", async () => {
    const workspaceId = await mountedWorkspace()

    const declaration = await fetch(`${origin}/api/claxedo/host-serving`)
    const bootstrap = await fetch(`${origin}/api/claxedo/bootstrap`)
    const catalog = await bootstrap.json() as {
      project: Array<{ workspaces?: Record<string, { id?: string; session_authority?: string }> }>
    }
    const row = catalog.project
      .flatMap((project) => Object.values(project.workspaces ?? {}))
      .find((workspace) => workspace.id === workspaceId)

    expect(await declaration.json()).toMatchObject({ sessionAuthority: "managed-private" })
    expect(row?.session_authority).toBe("local")
  })
})
