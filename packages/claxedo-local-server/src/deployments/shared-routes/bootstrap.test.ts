import { mkdtempSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { BootstrapRoutes, signedBootstrapProjects } from "./bootstrap"

const root = path.join(os.tmpdir(), `claxedo-bootstrap-route-${Date.now()}-${Math.random().toString(16).slice(2)}`)
const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
}

process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
process.env.CLAXEDO_STATE_DIR = path.join(root, "state")

afterAll(async () => {
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_STATE_DIR === undefined) delete process.env.CLAXEDO_STATE_DIR
  else process.env.CLAXEDO_STATE_DIR = previous.CLAXEDO_STATE_DIR
  await fs.rm(root, { recursive: true, force: true })
})

const catalogCacheDir = mkdtempSync(path.join(os.tmpdir(), "claxedo-bootstrap-catalog-"))

describe("BootstrapRoutes", () => {
  test("returns only Claxedo-owned bootstrap fields", async () => {
    const response = await BootstrapRoutes({ env: { npm_package_version: "9.9.9-test" } })
      .request("/api/claxedo/bootstrap")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      healthy: true,
      version: "9.9.9-test",
      path: { worktree: "", directory: "" },
      project: [],
    })
    expect(body.provider_auth).toBeDefined()
    expect(body.provider).toBeUndefined()
    expect(body.config).toBeUndefined()
    expect(body.config_providers).toBeUndefined()
  })

  test("shell scope omits credential presentation", async () => {
    const response = await BootstrapRoutes({ env: {} })
      .request("/api/claxedo/bootstrap?scope=shell")

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.provider_auth).toBeUndefined()
    expect(body.provider).toBeUndefined()
  })

  test("allows loopback browser bootstrap when a bearer is attached", async () => {
    const response = await BootstrapRoutes({
      authConfig: { enabled: false, mode: "local-only", reason: "local test" },
    }).request("http://127.0.0.1/api/claxedo/bootstrap", {
      headers: {
        Authorization: "Bearer local-test-token",
        Origin: "http://127.0.0.1:4444",
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ healthy: true })
  })
})

describe("signedBootstrapProjects", () => {
  // Every row a SIGNED bootstrap answers with is a control-plane workspace, so
  // it is relay-backed and is ADDRESSED by its id. The serving host's path is
  // location metadata about another machine: stating it as `directory` makes
  // `workspaceRouteIdentity` resolve a `/w/<id>` route to a path this app
  // cannot reach, its panes register that path as their scope, and every live
  // frame — which both event lanes publish under `workspace:<id>` — is dropped
  // for the mismatch.
  test("addresses a relay-backed workspace by id and keeps the host path as remote_directory", () => {
    expect(signedBootstrapProjects([
      {
        workspace_id: "ws_1",
        project_id: "proj_1",
        workspace_name: "Main",
        access: "user-hosted",
        remote_directory: "/Users/host/repo",
      },
    ])).toEqual([
      {
        id: "proj_1",
        name: "proj_1",
        worktree: "ws_1",
        sandboxes: ["ws_1"],
        workspaces: {
          ws_1: {
            id: "ws_1",
            kind: "user-hosted",
            workspace_name: "Main",
            directory: "workspace:ws_1",
            remote_directory: "/Users/host/repo",
          },
        },
      },
    ])
  })

  test("omits remote_directory when the row carries no host path", () => {
    const [project] = signedBootstrapProjects([{ workspace_id: "ws_2", access: "cloud" }])
    expect(project?.workspaces.ws_2).toEqual({
      id: "ws_2",
      kind: "cloud",
      workspace_name: "ws_2",
      directory: "workspace:ws_2",
    })
  })
})
