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
      access: "local",
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

  test("reports an already-registered relay workspace without importing hosted authority", async () => {
    await ensureWorkspace({
      workspaceId: "ws_user_hosted",
      directory: "workspace:ws_user_hosted",
      kind: "cloud",
    })

    const response = await LocalWorkspaceRoutes().request(
      "http://localhost/resolve?workspaceId=ws_user_hosted",
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      workspaceId: "ws_user_hosted",
      access: "user-hosted",
      backing: { kind: "user-hosted" },
      kind: "cloud",
    })

    const listed = await LocalWorkspaceRoutes().request("http://localhost/?access=user-hosted")
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      workspaces: [expect.objectContaining({ workspaceId: "ws_user_hosted", access: "user-hosted" })],
    })

    const cloud = await LocalWorkspaceRoutes().request("http://localhost/?access=cloud")
    await expect(cloud.json()).resolves.toEqual({ workspaces: [] })
  })
})
