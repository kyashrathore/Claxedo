import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { defined } from "./fixtures/assert-helpers"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `workspace-store-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./workspace-store")

function file() {
  return path.join(root, "workspaces.json")
}

async function saved() {
  return JSON.parse(await fs.readFile(file(), "utf-8")) as {
    version: number
    workspaces: Array<{
      id: string
      project_id?: string
      project_name?: string
      workspace_name?: string
      directory: string
      kind: string
      provider?: string
      repo_url?: string
      repo_key?: string
      repo_root?: string
      repo_name?: string
      git_branch?: string
      git_remote?: string
      sandbox_id?: string
      status?: string
      created_at: number
      updated_at: number
    }>
  }
}

function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

/** Minimal git repo — just enough for ensureWorkspace to accept it */
async function gitDir(name: string) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.md"), "# test\n")
  sh(`git init -b main ${dir}`)
  sh(`git -C ${dir} config user.email test@example.com`)
  sh(`git -C ${dir} config user.name test`)
  sh(`git -C ${dir} add README.md`)
  sh(`git -C ${dir} commit -m init`)
  return dir
}

/** Git repo with remote and worktree */
async function repo(name: string) {
  const dir = await gitDir(name)
  const sb = path.join(root, "repos", `${name}-sb`)
  sh(`git -C ${dir} remote add origin https://github.com/foo/${name}.git`)
  sh(`git -C ${dir} worktree add ${sb}`)
  return { dir, sb }
}

describe("workspace store", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  // ── ensureWorkspace ──────────────────────────────────────────────────────

  test("preserves provided workspaceId and reuses it for the same directory", async () => {
    const dir = await gitDir("demo")
    const first = defined(await mod.ensureWorkspace({
      workspaceId: "ws_123",
      directory: dir,
    }))
    const second = defined(await mod.ensureWorkspace({
      directory: dir,
    }))

    expect(first.id).toBe("ws_123")
    expect(second.id).toBe("ws_123")
    expect(second.directory).toBe(first.directory)

    const disk = await saved()
    expect(disk.workspaces.map((item) => item.id)).toEqual(["ws_123"])
    expect(disk.workspaces[0]?.project_id).toBe("ws_123")
    expect(disk.workspaces[0]?.kind).toBe("local")
  })

  test("generates a random id when workspaceId is omitted", async () => {
    const dir = await gitDir("auto-id")
    const ws = defined(await mod.ensureWorkspace({ directory: dir }))
    expect(ws.id).toBeTruthy()
    expect(ws.id).not.toBe("")
    expect(ws.directory).toContain("auto-id")
  })

  test("defaults project_id to workspace id when not provided", async () => {
    const dir = await gitDir("proj-default")
    const ws = defined(await mod.ensureWorkspace({
      workspaceId: "ws_proj",
      directory: dir,
    }))
    expect(ws.project_id).toBe("ws_proj")
  })

  test("uses explicit project_id when provided", async () => {
    const dir = await gitDir("proj-explicit")
    const ws = defined(await mod.ensureWorkspace({
      workspaceId: "ws_1",
      project_id: "proj_abc",
      directory: dir,
    }))
    expect(ws.project_id).toBe("proj_abc")
  })

  test("reuses project_id across git worktrees from the same repo", async () => {
    const git = await repo("shared")
    const first = defined(await mod.ensureWorkspace({
      workspaceId: "ws_main",
      directory: git.dir,
    }))
    const second = defined(await mod.ensureWorkspace({
      workspaceId: "ws_sb",
      directory: git.sb,
    }))

    expect(first.project_id).toBeTruthy()
    expect(second.project_id).toBe(first.project_id)
    expect(first.repo_name).toBe("shared")
    expect(second.repo_name).toBe("shared")
    expect(first.git_remote).toBe("https://github.com/foo/shared.git")
    expect(second.git_remote).toBe("https://github.com/foo/shared.git")
  })

  test("updates metadata on re-ensure without creating duplicates", async () => {
    const dir = await gitDir("update-meta")
    await mod.ensureWorkspace({
      workspaceId: "ws_up",
      directory: dir,
      kind: "local",
    })
    const updated = defined(await mod.ensureWorkspace({
      directory: dir,
      kind: "cloud",
      provider: "daytona",
      sandbox_id: "sb_123",
    }))

    expect(updated.id).toBe("ws_up")
    expect(updated.kind).toBe("cloud")
    expect(updated.provider).toBe("daytona")
    expect(updated.sandbox_id).toBe("sb_123")

    const disk = await saved()
    expect(disk.workspaces).toHaveLength(1)
  })

  test("trims whitespace from string fields", async () => {
    const dir = await gitDir("trim-test")
    const ws = defined(await mod.ensureWorkspace({
      workspaceId: "  ws_trim  ",
      project_name: "  my project  ",
      workspace_name: "  main  ",
      directory: dir,
      repo_url: "  https://github.com/foo/bar  ",
    }))

    expect(ws.project_name).toBe("my project")
    expect(ws.workspace_name).toBe("main")
    expect(ws.repo_url).toBe("https://github.com/foo/bar")
  })

  test("defaults kind to 'local' when not specified", async () => {
    const dir = await gitDir("default-kind")
    const ws = defined(await mod.ensureWorkspace({
      directory: dir,
    }))
    expect(ws.kind).toBe("local")
  })

  // ── getWorkspace / getWorkspaceByDirectory ────────────────────────────

  test("retrieves workspace by id", async () => {
    const dir = await gitDir("get-by-id")
    await mod.ensureWorkspace({ workspaceId: "ws_get", directory: dir })
    const ws = await mod.getWorkspace("ws_get")
    expect(ws).toBeDefined()
    expect(ws!.id).toBe("ws_get")
  })

  test("returns undefined for unknown workspace id", async () => {
    const ws = await mod.getWorkspace("ws_nonexistent_" + randomUUID())
    expect(ws).toBeUndefined()
  })

  test("retrieves workspace by directory", async () => {
    const dir = await gitDir("get-by-dir")
    await mod.ensureWorkspace({
      workspaceId: "ws_dir",
      directory: dir,
    })
    const ws = await mod.getWorkspaceByDirectory(dir)
    expect(ws).toBeDefined()
    expect(ws!.id).toBe("ws_dir")
  })

  // ── bindWorkspace ────────────────────────────────────────────────────

  test("rebinds workspace to a new directory", async () => {
    const oldDir = await gitDir("old-dir")
    const newDir = await gitDir("new-dir")
    await mod.ensureWorkspace({ workspaceId: "ws_bind", directory: oldDir })
    const rebound = defined(await mod.bindWorkspace("ws_bind", newDir))
    expect(rebound.id).toBe("ws_bind")
    expect(rebound.directory).toContain("new-dir")

    // old directory no longer resolves to this workspace
    const old = await mod.getWorkspaceByDirectory(oldDir)
    expect(old).toBeUndefined()

    // new directory resolves
    const fresh = await mod.getWorkspaceByDirectory(newDir)
    expect(fresh).toBeDefined()
    expect(fresh!.id).toBe("ws_bind")
  })

  test("bind with unknown id creates a new workspace", async () => {
    const dir = await gitDir("new-bind-dir")
    const ws = defined(await mod.bindWorkspace("ws_new_bind", dir))
    expect(ws.id).toBe("ws_new_bind")
    expect(ws.directory).toContain("new-bind-dir")
  })

  test("deletes workspace by directory", async () => {
    const dir = await gitDir("delete-me")
    await mod.ensureWorkspace({ workspaceId: "ws_del", directory: dir })
    expect(await mod.deleteWorkspaceByDirectory(dir)).toBe(true)
    expect(await mod.getWorkspace("ws_del")).toBeUndefined()
    expect(await mod.getWorkspaceByDirectory(dir)).toBeUndefined()
  })

  // ── resolveWorkspace ─────────────────────────────────────────────────

  test("resolves by workspaceId when it exists", async () => {
    const dir = await gitDir("resolve-id")
    await mod.ensureWorkspace({ workspaceId: "ws_resolve", directory: dir })
    const ws = await mod.resolveWorkspace({ workspaceId: "ws_resolve" })
    expect(ws).toBeDefined()
    expect(ws!.id).toBe("ws_resolve")
  })

  test("resolves by directory without creating", async () => {
    const dir = await gitDir("resolve-dir")
    await mod.ensureWorkspace({ workspaceId: "ws_rdir", directory: dir })
    const ws = await mod.resolveWorkspace({ directory: dir })
    expect(ws).toBeDefined()
    expect(ws!.id).toBe("ws_rdir")
  })

  test("returns undefined when directory not found and create is false", async () => {
    const ws = await mod.resolveWorkspace({ directory: "/tmp/nonexistent-resolve" })
    expect(ws).toBeUndefined()
  })

  test("creates workspace when create=true and directory is unknown", async () => {
    const dir = await gitDir("auto-create")
    const ws = await mod.resolveWorkspace({
      workspaceId: "ws_auto_create",
      directory: dir,
      create: true,
    })
    expect(ws).toBeDefined()
    expect(ws!.id).toBe("ws_auto_create")
    expect(ws!.directory).toContain("auto-create")
  })

  test("returns undefined when no id or directory is provided", async () => {
    const ws = await mod.resolveWorkspace({})
    expect(ws).toBeUndefined()
  })

  // ── listWorkspaces / listProjects ───────────────────────────────────

  test("lists workspaces sorted by most recently updated first", async () => {
    const dir1 = await gitDir("list-1")
    await mod.ensureWorkspace({ workspaceId: "ws_list_1", directory: dir1 })
    // small delay to ensure different updated_at
    await new Promise((r) => setTimeout(r, 10))
    const dir2 = await gitDir("list-2")
    await mod.ensureWorkspace({ workspaceId: "ws_list_2", directory: dir2 })

    const list = await mod.listWorkspaces()
    const ids = list.map((w) => w.id)
    const idx1 = ids.indexOf("ws_list_1")
    const idx2 = ids.indexOf("ws_list_2")
    expect(idx2).toBeLessThan(idx1)
  })

  test("groups workspaces into projects by project_id", async () => {
    const dirMain = await gitDir("proj-main")
    const dirSandbox = await gitDir("proj-sandbox")
    await mod.ensureWorkspace({
      workspaceId: "ws_proj_main",
      project_id: "proj_group",
      project_name: "MyProject",
      directory: dirMain,
    })
    await mod.ensureWorkspace({
      workspaceId: "ws_proj_sb",
      project_id: "proj_group",
      directory: dirSandbox,
    })

    const projects = await mod.listProjects()
    const proj = projects.find((p) => p.id === "proj_group")
    expect(proj).toBeDefined()
    expect(proj!.name).toBe("MyProject")
    // sandbox directories should include the non-main workspace
    expect(proj!.sandboxes.some((s) => s.includes("proj-sandbox"))).toBe(true)
  })

  test("marks missing local workspaces unavailable while leaving cloud workspaces available", async () => {
    const git = await repo("availability")
    await mod.ensureWorkspace({
      workspaceId: "ws_main",
      project_id: "proj_availability",
      directory: git.dir,
      kind: "local",
    })
    await mod.ensureWorkspace({
      workspaceId: "ws_local_missing",
      project_id: "proj_availability",
      directory: git.sb,
      kind: "local",
    })
    const cloud = path.join(root, "cloud", "availability")
    await fs.mkdir(cloud, { recursive: true })
    await mod.ensureWorkspace({
      workspaceId: "ws_cloud",
      project_id: "proj_availability",
      workspace_name: "cloud",
      directory: cloud,
      kind: "cloud",
      provider: "daytona",
    })

    await fs.rm(git.sb, { recursive: true, force: true })

    const projects = await mod.listProjects()
    const project = projects.find((item) => item.id === "proj_availability")
    expect(project).toBeDefined()
    expect(project!.workspaces[git.dir]?.available).toBe(true)
    expect(project!.workspaces[git.sb]?.available).toBe(false)
    expect(project!.workspaces[cloud]?.available).toBe(true)
  })

  test("hides pending cloud placeholders until the lease is ready", async () => {
    const cloud = path.join(root, "cloud", "pending")
    await fs.mkdir(cloud, { recursive: true })
    await mod.ensureWorkspace({
      workspaceId: "ws_cloud_pending",
      project_id: "proj_cloud_pending",
      workspace_name: "main",
      directory: cloud,
      kind: "cloud",
      provider: "daytona",
      status: "pending_sandbox",
    })

    let projects = await mod.listProjects()
    expect(projects.find((item) => item.id === "proj_cloud_pending")).toBeUndefined()

    await mod.updateWorkspace("ws_cloud_pending", {
      status: "ready",
      sandbox_id: "sb-pending",
      sandbox_url: "https://sandbox.example.com",
    })

    projects = await mod.listProjects()
    expect(projects.find((item) => item.id === "proj_cloud_pending")).toBeDefined()
  })

  // ── Persistence ──────────────────────────────────────────────────────

  test("persists version 3 format with sorted workspaces", async () => {
    const dir = await gitDir("v2")
    await mod.ensureWorkspace({ workspaceId: "ws_v2", directory: dir })
    const disk = await saved()
    expect(disk.version).toBe(3)
    expect(disk.workspaces[0].id).toBe("ws_v2")
    expect(typeof disk.workspaces[0].created_at).toBe("number")
    expect(typeof disk.workspaces[0].updated_at).toBe("number")
  })

  test("timestamps are set on creation and updated on re-ensure", async () => {
    const dir = await gitDir("timestamps")
    const first = defined(await mod.ensureWorkspace({ workspaceId: "ws_ts", directory: dir }))
    expect(first.created_at).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 10))
    const second = defined(await mod.ensureWorkspace({ directory: dir }))
    expect(second.created_at).toBe(first.created_at)
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at)
  })
})
