import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-workspace-resolve-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { LocalWorkspaceRoutes } = await import("./resolve-route")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

describe("local workspace resolve route", () => {
  test("creates and resolves a local workspace without hosted workspace authority", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(root, "repo-")))
    execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
    const create = await LocalWorkspaceRoutes().request(
      `http://localhost/resolve?directory=${encodeURIComponent(directory)}&create=true`,
    )

    expect(create.status).toBe(200)
    const created = await create.json() as Record<string, unknown>
    expect(created).toMatchObject({
      workspaceId: expect.any(String),
      projectId: expect.any(String),
      directory,
      backing: { kind: "local-worktree", directory },
      kind: "local",
    })

    const lookup = await LocalWorkspaceRoutes().request(
      `http://localhost/resolve?workspaceId=${encodeURIComponent(String(created.workspaceId))}`,
    )
    expect(lookup.status).toBe(200)
    expect(await lookup.json()).toMatchObject({
      workspaceId: created.workspaceId,
      directory,
      kind: "local",
    })
  })

  test("rejects missing input and does not synthesize missing workspaces", async () => {
    const missingInput = await LocalWorkspaceRoutes().request("http://localhost/resolve")
    expect(missingInput.status).toBe(400)
    expect(await missingInput.json()).toMatchObject({
      error: { code: "workspace_resolve_input_required" },
    })

    const missingWorkspace = await LocalWorkspaceRoutes().request(
      "http://localhost/resolve?workspaceId=ws_missing",
    )
    expect(missingWorkspace.status).toBe(404)
    expect(await missingWorkspace.json()).toMatchObject({
      error: { code: "workspace_not_found" },
    })
  })

  test("reports a provisioner-placed workspace without importing hosted authority", async () => {
    await ensureWorkspace({
      workspaceId: "ws_provisioned",
      directory: "workspace:ws_provisioned",
      remote_directory: "/workspace",
      kind: "cloud",
      driver: "daytona",
    })

    const response = await LocalWorkspaceRoutes().request(
      "http://localhost/resolve?workspaceId=ws_provisioned",
    )
    expect(response.status).toBe(200)
    // The placement, which is the fact.
    expect(await response.json()).toMatchObject({
      workspaceId: "ws_provisioned",
      backing: { kind: "cloud-vm", driver: "daytona" },
      directory: "/workspace",
    })

    // The LIST contract, not the resolve one: a bare `backing` word and the
    // authority's snake-case keys. A client narrows a list row by comparing
    // that field, so the resolve projection's object `backing` would make it
    // drop the whole list.
    const listed = await LocalWorkspaceRoutes().request("http://localhost/?host=provisioner")
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual({
      workspaces: [{
        workspace_id: "ws_provisioned",
        project_id: "ws_provisioned",
        backing: "cloud-vm",
        remote_directory: "/workspace",
      }],
    })
  })

  // A worktree on this machine is reached over loopback through the project
  // inventory. Listed here it would carry no `placement.host_enrollment_id`,
  // and a client reads a machine it cannot place as one it cannot reach.
  test("lists no worktree of its own, under any host", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(root, "listed-")))
    execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
    await LocalWorkspaceRoutes().request(
      `http://localhost/resolve?directory=${encodeURIComponent(directory)}&create=true`,
    )

    for (const scope of ["", "?host=machine", "?host=provisioner"]) {
      const listed = await LocalWorkspaceRoutes().request(`http://localhost/${scope}`)
      expect(listed.status, scope).toBe(200)
      const body = await listed.json() as { workspaces: { remote_directory?: string }[] }
      expect(body.workspaces.some((row) => row.remote_directory === directory), scope).toBe(false)
    }
  })

  test("refuses a host it cannot answer rather than guessing one", async () => {
    for (const query of ["?host=local", "?host=user-hosted", "?host=cloud"]) {
      const response = await LocalWorkspaceRoutes().request(`http://localhost/${query}`)
      expect(response.status, query).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: { code: "workspace_host_invalid" } })
    }
  })

  // The provisioner owns the machine it provisions, so a row that names no
  // driver names no machine; the store refuses it rather than keeping a
  // placement nothing can resolve.
  test("refuses to store a provisioner row that names no driver", async () => {
    await expect(ensureWorkspace({
      workspaceId: "ws_driverless",
      directory: "workspace:ws_driverless",
      kind: "cloud",
    })).resolves.toBeUndefined()

    const response = await LocalWorkspaceRoutes().request(
      "http://localhost/resolve?workspaceId=ws_driverless",
    )
    expect(response.status).toBe(404)
  })
})
