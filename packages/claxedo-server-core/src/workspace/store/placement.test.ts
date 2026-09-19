import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { workspacePlacement } from "./placement"
import { workspaceBacking } from "./backing"
import { ensureWorkspace, getWorkspace, type Workspace } from "./index"

function ws(input: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    directory: "/tmp/repo",
    kind: "local",
    created_at: 0,
    updated_at: 0,
    ...input,
  }
}

describe("workspacePlacement", () => {
  test("a local row is placed on this machine at its own directory", () => {
    expect(workspacePlacement(ws({ directory: "/tmp/repo" }))).toEqual({
      host: { kind: "self" },
      directory: "/tmp/repo",
    })
  })

  test("a driver places the workspace on the machine that driver provisions", () => {
    expect(workspacePlacement(ws({ kind: "cloud", driver: "daytona", remote_directory: "/workspace/repo" }))).toEqual({
      host: { kind: "provisioner", driver: "daytona" },
      directory: "/workspace/repo",
    })
  })

  test("a stored cloud row that names no driver is still the provisioner's", () => {
    expect(workspacePlacement(ws({ kind: "cloud", directory: "/workspace" }))).toEqual({
      host: { kind: "provisioner" },
      directory: "/workspace",
    })
  })
})

describe("workspaceBacking reads the placement", () => {
  test("this machine's placement is a local worktree", () => {
    expect(workspaceBacking(ws({ directory: "/tmp/repo", git_branch: "main" }))).toEqual({
      kind: "local-worktree",
      directory: "/tmp/repo",
      branch: "main",
    })
  })

  test("a provisioner placement is a cloud VM carrying its driver", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      driver: "daytona",
      workspace_name: "feature-x",
      remote_directory: "/workspace/repo",
    }))).toEqual({
      kind: "cloud-vm",
      driver: "daytona",
      workspaceName: "feature-x",
      remoteDirectory: "/workspace/repo",
    })
  })

  test("a stored cloud row that names no driver is a cloud VM, never the user's own machine", () => {
    const backing = workspaceBacking(ws({ kind: "cloud", directory: "/workspace", workspace_name: "legacy" }))
    expect(backing.kind).toBe("cloud-vm")
    expect(backing).not.toHaveProperty("driver")
  })
})

describe("ensureWorkspace requires a placement for a cloud row", () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-workspace-placement-"))
    process.env.CLAXEDO_DATA_DIR = dir
  })
  afterEach(async () => {
    delete process.env.CLAXEDO_DATA_DIR
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("refuses to create a cloud row that names no driver", async () => {
    expect(await ensureWorkspace({
      workspaceId: "ws_a",
      kind: "cloud",
      directory: "/workspace",
      remote_directory: "/code/api",
    })).toBeUndefined()
    expect(await getWorkspace("ws_a")).toBeUndefined()
  })

  test("refuses to re-ensure a stored cloud row that still names no driver, and leaves it stored", async () => {
    // Rows in this shape predate the create-time refusal: the only writer that
    // produced them spread the driver in conditionally. They load, list and
    // resolve; what they cannot do is come back through `ensureWorkspace`
    // without naming a machine.
    await fs.writeFile(path.join(dir, "workspaces.json"), JSON.stringify({
      version: 4,
      workspaces: [{
        id: "ws_legacy",
        project_id: "ws_legacy",
        workspace_name: "Legacy root",
        directory: "/workspace",
        remote_directory: "/workspace",
        kind: "cloud",
        created_at: 1,
        updated_at: 1,
      }],
      projects: [],
    }))

    const stored = await getWorkspace("ws_legacy")
    expect(stored).toMatchObject({ id: "ws_legacy", kind: "cloud" })
    expect(stored).not.toHaveProperty("driver", expect.anything())

    expect(await ensureWorkspace({
      workspaceId: "ws_legacy",
      kind: "cloud",
      directory: "/workspace",
      workspace_name: "Renamed",
    })).toBeUndefined()
    expect(await getWorkspace("ws_legacy")).toMatchObject({ workspace_name: "Legacy root", updated_at: 1 })
  })

  test("stores a cloud row that names one, and refuses to merge a driver away", async () => {
    const created = await ensureWorkspace({
      workspaceId: "ws_b",
      kind: "cloud",
      directory: "/workspace",
      driver: "daytona",
    })
    expect(created?.driver).toBe("daytona")
    expect((await ensureWorkspace({ workspaceId: "ws_b", kind: "cloud", directory: "/workspace" }))?.driver)
      .toBe("daytona")
  })
})

const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

async function productionSources() {
  const packages = await fs.readdir(path.join(repositoryRoot, "packages"), { withFileTypes: true })
  const files: string[] = []
  for (const entry of packages) {
    if (!entry.isDirectory()) continue
    const root = path.join(repositoryRoot, "packages", entry.name, "src")
    const walk = async (directory: string) => {
      const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const child of children) {
        const full = path.join(directory, child.name)
        if (child.isDirectory()) {
          await walk(full)
          continue
        }
        if (!/\.(tsx?|mjs)$/.test(child.name)) continue
        if (/\.(test|vitest)\.tsx?$/.test(child.name)) continue
        files.push(full)
      }
    }
    await walk(root)
  }
  return files
}

/** The argument list of the call beginning at `open`, by paren matching. */
function callArguments(source: string, open: number) {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === "(") depth += 1
    else if (character === ")") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return source.slice(open + 1)
}

/**
 * Every production write of a `cloud` row, as the arguments passed to
 * `ensureWorkspace`.
 *
 * A conditional spread (`...(x ? { driver } : {})`) is not a placement: it
 * leaves the row naming no machine whenever the condition is false, so only a
 * plain `driver:` property counts.
 */
async function productionCloudWorkspaceWrites() {
  const writes: { file: string; literal: string }[] = []
  for (const file of await productionSources()) {
    const source = await fs.readFile(file, "utf-8")
    let cursor = source.indexOf("ensureWorkspace(")
    while (cursor !== -1) {
      const literal = callArguments(source, cursor + "ensureWorkspace".length)
      if (/\bkind: "cloud"/.test(literal)) writes.push({ file: path.relative(repositoryRoot, file), literal })
      cursor = source.indexOf("ensureWorkspace(", cursor + 1)
    }
  }
  return writes
}

describe("production cloud rows", () => {
  test("every production cloud row names its driver", async () => {
    const writes = await productionCloudWorkspaceWrites()
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.filter((write) => !/^\s+driver\s*[,:]/m.test(write.literal)).map((write) => write.file))
      .toEqual([])
  })
})
