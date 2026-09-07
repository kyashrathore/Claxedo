import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ensureWorkspace, listWorkspaces } from "./index"

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

    const write = ensureWorkspace({ kind: "cloud", directory: "/workspace", repo_url: "https://github.com/acme/repo.git" })
    await renameStarted
    const read = listWorkspaces()
    release()

    const created = await write
    expect(created).toBeDefined()
    expect((await read).map((row) => row.id)).toEqual([created!.id])
    expect((await listWorkspaces()).map((row) => row.id)).toEqual([created!.id])
  })

  test("a store file deleted underneath a loaded store reloads as empty", async () => {
    const created = await ensureWorkspace({ kind: "cloud", directory: "/workspace", repo_url: "https://github.com/acme/repo.git" })
    expect(created).toBeDefined()
    await fs.rm(path.join(dir, "workspaces.json"))
    expect(await listWorkspaces()).toEqual([])
  })
})
