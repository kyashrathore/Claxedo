import { execFileSync } from "node:child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ensureWorkspace, listProjects, listWorkspaces } from "./index"
import { configureLocalWorkspaceRuntime } from "../local-runtime-port"

describe("workspace store boot", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-workspace-store-"))
    process.env.CLAXEDO_DATA_DIR = dir
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.CLAXEDO_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("a read during the first save of a new store keeps the rows that save is persisting", async () => {
    let release!: () => void
    const landed = new Promise<void>((resolve) => {
      release = resolve
    })
    let renaming!: () => void
    const renameStarted = new Promise<void>((resolve) => {
      renaming = resolve
    })
    const rename = fs.rename
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renaming()
      await landed
      return rename(from, to)
    })

    const write = ensureWorkspace({ kind: "cloud", driver: "daytona", directory: "/workspace", repo_url: "https://github.com/acme/repo.git" })
    await renameStarted
    const read = listWorkspaces()
    release()

    const created = await write
    expect(created).toBeDefined()
    expect((await read).map((row) => row.id)).toEqual([created!.id])
    expect((await listWorkspaces()).map((row) => row.id)).toEqual([created!.id])
  })

  test("a store file deleted underneath a loaded store reloads as empty", async () => {
    const created = await ensureWorkspace({ kind: "cloud", driver: "daytona", directory: "/workspace", repo_url: "https://github.com/acme/repo.git" })
    expect(created).toBeDefined()
    await fs.rm(path.join(dir, "workspaces.json"))
    expect(await listWorkspaces()).toEqual([])
  })
})

describe("the project catalog's session composition", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-workspace-catalog-"))
    process.env.CLAXEDO_DATA_DIR = dir
  })
  afterEach(async () => {
    configureLocalWorkspaceRuntime(undefined)
    delete process.env.CLAXEDO_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  // A local row is only created for a real git checkout.
  const local = async () => {
    const repo = await fs.realpath(await fs.mkdtemp(path.join(dir, "repo-")))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, stdio: "ignore" })
    return await ensureWorkspace({ kind: "local", directory: repo })
  }
  const workspaceRows = async () =>
    (await listProjects()).flatMap((project) => Object.values(project.workspaces))

  test("publishes the composition the serving process declares for the workspaces it runs", async () => {
    // The client cannot derive this: the same loopback address serves an
    // unsigned daemon and a signed self-hosted server, and only one of them
    // refuses `POST /session` without a reservation.
    configureLocalWorkspaceRuntime({
      fetch: async () => new Response(null, { status: 404 }),
      sessionAuthority: () => "managed-private",
    })
    await local()
    expect(await workspaceRows()).toEqual([
      expect.objectContaining({ kind: "local", session_authority: "managed-private" }),
    ])
  })

  test("says local when that is what this process mounted", async () => {
    configureLocalWorkspaceRuntime({
      fetch: async () => new Response(null, { status: 404 }),
      sessionAuthority: () => "local",
    })
    await local()
    expect(await workspaceRows()).toEqual([
      expect.objectContaining({ kind: "local", session_authority: "local" }),
    ])
  })

  test("declares nothing for a workspace this process does not serve", async () => {
    // A cloud row names a runtime on another machine. This server has no
    // standing to state how that one composed session access, and a wrong
    // guess either strands the client on a refused create or makes it reserve
    // at a control plane that has no reservation to give.
    configureLocalWorkspaceRuntime({
      fetch: async () => new Response(null, { status: 404 }),
      sessionAuthority: () => "managed-private",
    })
    await ensureWorkspace({ kind: "cloud", driver: "daytona", directory: "/workspace", repo_url: "https://github.com/acme/repo.git" })
    expect(await workspaceRows()).toEqual([
      expect.not.objectContaining({ session_authority: expect.anything() }),
    ])
  })

  test("declares nothing when no composition installed a runtime port", async () => {
    await local()
    expect(await workspaceRows()).toEqual([
      expect.not.objectContaining({ session_authority: expect.anything() }),
    ])
  })
})
