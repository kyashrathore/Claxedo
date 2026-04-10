/**
 * Workspace Store Integrity Tests
 *
 * End-to-end tests (up to API layer, no UI) that assert the workspace store
 * and listProjects() produce correct, sane data.  Most of these will fail
 * until the underlying bugs are fixed — that is intentional.
 *
 * Covers:
 *  1. Cloud container paths (e.g. /workspace) must never become local projects
 *  2. Sentinel directories (__pages__) must never be stored
 *  3. listProjects() must not invert local/cloud roles when both exist
 *  4. Project kind must reflect the main workspace's kind
 *  5. Sandbox naming must not reduce to a misleading basename
 */
import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { defined } from "./fixtures/assert-helpers"
import { execSync } from "child_process"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

// Isolated data dir so we don't touch the real ~/.claxedo
const root = path.join(realpathSync(os.tmpdir()), `ws-integrity-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./workspace-store")

/** Read the persisted workspaces.json from disk */
function sh(cmd: string) { execSync(cmd, { stdio: "ignore" }) }

async function saved() {
  return JSON.parse(await fs.readFile(path.join(root, "workspaces.json"), "utf-8")) as {
    version: number
    workspaces: Array<{
      id: string
      project_id?: string
      project_name?: string
      workspace_name?: string
      directory: string
      kind: string
      provider?: string
      repo_key?: string
      repo_root?: string
      repo_name?: string
      git_branch?: string
      git_remote?: string
      remote_directory?: string
      sandbox_id?: string
      status?: string
      created_at: number
      updated_at: number
    }>
  }
}

/** Create a real git repo with a worktree (sandbox) for realistic tests */
async function repo(name: string) {
  const dir = path.join(root, "repos", name)
  const sb = path.join(root, "repos", `${name}-sb`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "README.md"), "# test\n")
  sh(`git init -b main ${dir}`)
  sh(`git -C ${dir} config user.email test@example.com`)
  sh(`git -C ${dir} config user.name test`)
  sh(`git -C ${dir} remote add origin https://github.com/acme/${name}.git`)
  sh(`git -C ${dir} add README.md`)
  sh(`git -C ${dir} commit -m init`)
  sh(`git -C ${dir} worktree add ${sb}`)
  return { dir, sb }
}

describe("workspace store integrity", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  // ────────────────────────────────────────────────────────────────────────
  // 1. Cloud container paths must not become local projects
  // ────────────────────────────────────────────────────────────────────────

  describe("cloud container path rejection", () => {
    test("ensureWorkspace rejects /workspace as a local workspace", async () => {
      // /workspace is the WORKSPACE_DIR inside cloud containers.
      // It must not be stored as a local workspace on the host.
      const ws = await mod.ensureWorkspace({ directory: "/workspace" })
      // The store should either reject this entirely or mark it non-local.
      // A local entry for a container-only path is always wrong.
      const all = await mod.listWorkspaces()
      const hit = all.find((w) => w.directory === "/workspace" && w.kind === "local")
      expect(hit).toBeUndefined()
    })

    test("resolveWorkspace with create=true rejects /workspace", async () => {
      const ws = await mod.resolveWorkspace({
        directory: "/workspace",
        create: true,
      })
      // Should not create a workspace for container-internal path
      const all = await mod.listWorkspaces()
      const hit = all.find((w) => w.directory === "/workspace" && w.kind === "local")
      expect(hit).toBeUndefined()
    })

    test("listProjects does not return /workspace as a project", async () => {
      // Even if somehow /workspace sneaks into the store,
      // listProjects must not surface it as a standalone project.
      await mod.ensureWorkspace({
        workspaceId: "ws_container",
        directory: "/workspace",
        kind: "local",
      })
      const projects = await mod.listProjects()
      const bad = projects.find((p) => p.worktree === "/workspace")
      expect(bad).toBeUndefined()
    })

    test("cloud workspace remote_directory does not leak as a separate project", async () => {
      // Simulate the real scenario: a cloud workspace with remote_directory=/workspace
      // and a local checkout sharing the same project_id.
      const git = await repo("myapp")

      // Local checkout
      await mod.ensureWorkspace({
        workspaceId: "ws_local_main",
        project_id: "proj_1",
        directory: git.dir,
        kind: "local",
      })

      // Cloud sandbox with remote_directory pointing to /workspace inside container
      const cloudDir = path.join(root, "cloud", "workspaces", "proj_1", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_cloud_main",
        project_id: "proj_1",
        project_name: "myapp",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      })

      const projects = await mod.listProjects()

      // /workspace must not appear as a project worktree or sandbox
      for (const p of projects) {
        expect(p.worktree).not.toBe("/workspace")
        expect(p.sandboxes).not.toContain("/workspace")
      }
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 2. Sentinel directories must never be stored
  // ────────────────────────────────────────────────────────────────────────

  describe("sentinel directory rejection", () => {
    test("ensureWorkspace rejects __pages__ directory", async () => {
      // __pages__ is a frontend sentinel, not a real directory.
      // It must never create a workspace entry.
      const before = await mod.listWorkspaces()
      try {
        await mod.ensureWorkspace({ directory: "__pages__" })
      } catch {
        // Throwing is acceptable
      }
      const after = await mod.listWorkspaces()
      const hit = after.find((w) => w.directory.includes("__pages__"))
      expect(hit).toBeUndefined()
    })

    test("resolveWorkspace with create=true rejects __pages__", async () => {
      const ws = await mod.resolveWorkspace({
        directory: "__pages__",
        create: true,
      })
      const all = await mod.listWorkspaces()
      const hit = all.find((w) => w.directory.includes("__pages__"))
      expect(hit).toBeUndefined()
    })

    test("ensureWorkspace rejects absolute path containing __pages__", async () => {
      // The real bug: the frontend sends an absolute path like
      // /Users/.../claxedo-server/__pages__
      const dir = path.join(root, "__pages__")
      try {
        await mod.ensureWorkspace({ directory: dir })
      } catch {
        // Throwing is acceptable
      }
      const all = await mod.listWorkspaces()
      const hit = all.find((w) => w.directory.includes("__pages__"))
      expect(hit).toBeUndefined()
    })

    test("listProjects never returns a __pages__ project", async () => {
      // Force-insert a __pages__ entry and verify listProjects filters it out
      const dir = path.join(root, "__pages__")
      await fs.mkdir(dir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_pages",
        directory: dir,
        kind: "local",
      })
      const projects = await mod.listProjects()
      const bad = projects.find((p) =>
        p.worktree.includes("__pages__") ||
        p.sandboxes.some((s) => s.includes("__pages__")),
      )
      expect(bad).toBeUndefined()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 3. listProjects must not invert local/cloud roles
  // ────────────────────────────────────────────────────────────────────────

  describe("local + cloud project grouping", () => {
    test("local checkout is not demoted to sandbox when cloud workspace has workspace_name=main", async () => {
      const git = await repo("coolapp")

      // Local checkout created first — it IS the original project.
      // Its id equals its project_id (self-root).
      const local = defined(await mod.ensureWorkspace({
        workspaceId: "proj_cool",
        project_id: "proj_cool",
        directory: git.dir,
        kind: "local",
      }))

      // Cloud sandbox added later with workspace_name="main"
      const cloudDir = path.join(root, "cloud", "workspaces", "proj_cool", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_cool_cloud",
        project_id: "proj_cool",
        project_name: "coolapp",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_cool")
      expect(proj).toBeDefined()

      // The local checkout must be the project worktree, not a sandbox.
      // A cloud workspace with workspace_name="main" must not steal the root.
      expect(proj!.worktree).toBe(local.directory)
      expect(proj!.sandboxes).not.toContain(local.directory)
    })

    test("both local and cloud workspaces appear under one project", async () => {
      const git = await repo("dualws")

      await mod.ensureWorkspace({
        workspaceId: "proj_dual",
        project_id: "proj_dual",
        directory: git.dir,
        kind: "local",
      })

      const cloudDir = path.join(root, "cloud", "workspaces", "proj_dual", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_dual_cloud",
        project_id: "proj_dual",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_dual")
      expect(proj).toBeDefined()

      // Project must have exactly 1 sandbox (the non-root workspace)
      // — the root itself is not in sandboxes.
      expect(proj!.sandboxes).toHaveLength(1)
      // The combined set of worktree + sandboxes must cover both directories.
      const allDirs = [proj!.worktree, ...proj!.sandboxes]
      expect(allDirs).toContain(git.dir)
      expect(allDirs).toContain(cloudDir)
    })

    test("git metadata comes from the local checkout, not the cloud proxy dir", async () => {
      const git = await repo("metacheck")

      await mod.ensureWorkspace({
        workspaceId: "proj_meta",
        project_id: "proj_meta",
        directory: git.dir,
        kind: "local",
      })

      const cloudDir = path.join(root, "cloud", "workspaces", "proj_meta", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_meta_cloud",
        project_id: "proj_meta",
        project_name: "metacheck",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_meta")
      expect(proj).toBeDefined()

      // Git info (repo, branch, remote) must come from the local checkout
      // which has actual git data, not the cloud proxy dir which has none.
      expect(proj!.git.repo).toBe("metacheck")
      expect(proj!.git.remote).toBe("https://github.com/acme/metacheck.git")
      expect(proj!.git.branch).toBe("main")
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 4. main() priority must not let workspace_name override self-root
  // ────────────────────────────────────────────────────────────────────────

  describe("main() root selection", () => {
    test("self-root workspace (id===project_id) takes priority over workspace_name=main", async () => {
      // The first workspace created for a project has id===project_id.
      // A later cloud workspace with workspace_name="main" must not steal root.
      const git = await repo("priority-check")

      await mod.ensureWorkspace({
        workspaceId: "proj_priority",
        project_id: "proj_priority",
        directory: git.dir,
        kind: "local",
      })

      const cloudDir = path.join(root, "cloud", "workspaces", "proj_priority", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_priority_cloud",
        project_id: "proj_priority",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_priority")
      expect(proj).toBeDefined()
      expect(proj!.worktree).toBe(git.dir)
    })

    test("when only cloud workspaces exist, workspace_name=main is fine as root", async () => {
      const cloudMain = path.join(root, "cloud", "workspaces", "proj_only_cloud", "main")
      const cloudFeat = path.join(root, "cloud", "workspaces", "proj_only_cloud", "feature")
      await fs.mkdir(cloudMain, { recursive: true })
      await fs.mkdir(cloudFeat, { recursive: true })

      await mod.ensureWorkspace({
        workspaceId: "ws_oc_main",
        project_id: "proj_only_cloud",
        workspace_name: "main",
        directory: cloudMain,
        kind: "cloud",
        provider: "daytona",
      })
      await mod.ensureWorkspace({
        workspaceId: "ws_oc_feat",
        project_id: "proj_only_cloud",
        workspace_name: "feature",
        directory: cloudFeat,
        kind: "cloud",
        provider: "daytona",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_only_cloud")
      expect(proj).toBeDefined()
      expect(proj!.worktree).toBe(cloudMain)
      expect(proj!.sandboxes).toContain(cloudFeat)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 5. Project name derivation
  // ────────────────────────────────────────────────────────────────────────

  describe("project name derivation", () => {
    test("project name comes from project_name when set", async () => {
      const git = await repo("named-proj")

      await mod.ensureWorkspace({
        workspaceId: "ws_named",
        project_id: "proj_named",
        project_name: "MyApp",
        directory: git.dir,
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_named")
      expect(proj).toBeDefined()
      expect(proj!.name).toBe("MyApp")
    })

    test("project name falls back to repo_name from git", async () => {
      const git = await repo("fallback-name")

      await mod.ensureWorkspace({
        workspaceId: "ws_fb",
        project_id: "proj_fb",
        directory: git.dir,
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_fb")
      expect(proj).toBeDefined()
      expect(proj!.name).toBe("fallback-name")
    })

    test("non-git directory is rejected — no project created", async () => {
      const dir = `/tmp/ws-integrity-bare-${randomUUID().slice(0, 8)}`
      await fs.mkdir(dir, { recursive: true })
      try {
        const ws = await mod.ensureWorkspace({
          workspaceId: "ws_bare",
          project_id: "proj_bare",
          directory: dir,
        })
        expect(ws).toBeUndefined()

        const projects = await mod.listProjects()
        const proj = projects.find((p) => p.id === "proj_bare")
        expect(proj).toBeUndefined()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    test("project name never falls back to basename 'workspace' from /workspace path", async () => {
      // /workspace as a directory yields basename "workspace" — a meaningless name.
      // If this entry somehow exists, the name must not be "workspace".
      await mod.ensureWorkspace({
        workspaceId: "ws_bad_name",
        project_id: "proj_bad_name",
        directory: "/workspace",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_bad_name")
      // Either the project should not exist at all (rejected), or if it does
      // exist, its name must not be the meaningless "workspace".
      if (proj) {
        expect(proj.name).not.toBe("workspace")
      }
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 6. Realistic scenario: reproduce the actual bug
  // ────────────────────────────────────────────────────────────────────────

  describe("real-world scenario: local dev + cloud sandbox", () => {
    test("reproduces the Claxedo bug: local checkout must not become 'opencode' sandbox", async () => {
      // This reproduces exactly what happens:
      // 1. User has local checkout at /Users/.../test/opencode (kind=local)
      // 2. Cloud workspace is created with workspace_name="main" (kind=cloud)
      // 3. Both share project_id
      // 4. BUG: listProjects() picks cloud as root, local becomes sandbox named "opencode"

      const git = await repo("Claxedo")

      // Step 1: local checkout — this is the REAL project root
      await mod.ensureWorkspace({
        workspaceId: "proj_clax",
        project_id: "proj_clax",
        directory: git.dir,
        kind: "local",
      })

      // Step 2: cloud sandbox
      const cloudDir = path.join(root, "cloud", "workspaces", "proj_clax", "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: "ws_clax_cloud",
        project_id: "proj_clax",
        project_name: "Claxedo",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      })

      const projects = await mod.listProjects()

      // Must be exactly one project for this project_id
      const matching = projects.filter((p) => p.id === "proj_clax")
      expect(matching).toHaveLength(1)

      const proj = matching[0]!

      // The local git checkout must be the project worktree (it has real git data)
      expect(proj.worktree).toBe(git.dir)

      // The cloud dir is a sandbox, not the worktree
      expect(proj.sandboxes).toContain(cloudDir)

      // The local checkout must NOT appear in sandboxes
      expect(proj.sandboxes).not.toContain(git.dir)

      // Git metadata comes from local checkout
      expect(proj.git.repo).toBe("Claxedo")
      expect(proj.git.remote).toBe("https://github.com/acme/Claxedo.git")

      // /workspace (remote_directory) never appears anywhere
      expect(proj.worktree).not.toBe("/workspace")
      expect(proj.sandboxes).not.toContain("/workspace")
    })

    test("reproduces the /workspace orphan bug", async () => {
      // Something called ensureWorkspace({ directory: "/workspace" }) — the
      // remote_directory leaked as a real workspace. It must not produce a project.

      // First create a legitimate project
      const git = await repo("RealApp")
      await mod.ensureWorkspace({
        workspaceId: "proj_real",
        project_id: "proj_real",
        directory: git.dir,
        kind: "local",
      })

      // Now the leak happens: /workspace gets ensured as local
      await mod.ensureWorkspace({
        workspaceId: "ws_leaked",
        directory: "/workspace",
        kind: "local",
      })

      const projects = await mod.listProjects()

      // /workspace must not appear as a project
      const bad = projects.find((p) => p.worktree === "/workspace")
      expect(bad).toBeUndefined()

      // The real project is unaffected
      const good = projects.find((p) => p.id === "proj_real")
      expect(good).toBeDefined()
      expect(good!.worktree).toBe(git.dir)
    })

    test("reproduces the __pages__ leak through ensureProject → resolveWorkspace", async () => {
      // The frontend calls ensureProject("__pages__") which calls
      // GET /api/workspace/resolve?directory=__pages__&create=true
      // This must not create a workspace.

      const before = (await mod.listWorkspaces()).length

      await mod.resolveWorkspace({
        directory: "__pages__",
        create: true,
      })

      const after = await mod.listWorkspaces()
      // No new workspace created
      expect(after.length).toBe(before)

      // And definitely no project
      const projects = await mod.listProjects()
      const bad = projects.find((p) => p.worktree.includes("__pages__"))
      expect(bad).toBeUndefined()
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 7. Edge cases
  // ────────────────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("ensureWorkspace rejects empty directory", async () => {
      try {
        await mod.ensureWorkspace({ directory: "" })
      } catch {
        // Expected
        return
      }
      // If it didn't throw, it must not have stored anything meaningful
      const all = await mod.listWorkspaces()
      const bad = all.find((w) => w.directory === "" || w.directory === ".")
      expect(bad).toBeUndefined()
    })

    test("ensureWorkspace rejects whitespace-only directory", async () => {
      try {
        await mod.ensureWorkspace({ directory: "   " })
      } catch {
        return
      }
      const all = await mod.listWorkspaces()
      const bad = all.find((w) => w.directory === "" || w.directory === ".")
      expect(bad).toBeUndefined()
    })

    test("deleting a workspace removes it from the project", async () => {
      const git = await repo("del-test")

      await mod.ensureWorkspace({
        workspaceId: "proj_del",
        project_id: "proj_del",
        directory: git.dir,
      })
      await mod.ensureWorkspace({
        workspaceId: "ws_del_sb",
        project_id: "proj_del",
        workspace_name: "feature",
        directory: git.sb,
      })

      // Delete the sandbox
      await mod.deleteWorkspaceByDirectory(git.sb)

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === "proj_del")
      expect(proj).toBeDefined()
      expect(proj!.sandboxes).not.toContain(git.sb)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 8. Adding a project derives identity from git repo
  // ────────────────────────────────────────────────────────────────────────

  describe("adding a project", () => {
    test("first workspace for a repo creates a project with unique id", async () => {
      const git = await repo("my-service")

      const ws = defined(await mod.ensureWorkspace({ directory: git.dir }))

      // A project must exist for this workspace
      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.worktree === git.dir)
      expect(proj).toBeDefined()

      // Project id must be the workspace's own id (self-root: id === project_id)
      expect(proj!.id).toBe(ws.project_id)
      expect(ws.id).toBe(ws.project_id)
    })

    test("project name is derived from git remote (repo name), not directory basename", async () => {
      // Repo remote is https://github.com/acme/my-service.git
      // Directory basename might be something else entirely
      const git = await repo("my-service")

      await mod.ensureWorkspace({ directory: git.dir })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.worktree === git.dir)
      expect(proj).toBeDefined()

      // Name must come from the git remote, not the directory
      expect(proj!.name).toBe("my-service")
      expect(proj!.git.repo).toBe("my-service")
      expect(proj!.git.remote).toBe("https://github.com/acme/my-service.git")
    })

    test("project name falls back to directory basename when no git remote", async () => {
      const dir = path.join(root, "repos", "no-remote-proj")
      await fs.mkdir(dir, { recursive: true })
      sh(`git init -b main ${dir}`)
      sh(`git -C ${dir} config user.email test@example.com`)
      sh(`git -C ${dir} config user.name test`)
      await fs.writeFile(path.join(dir, "README.md"), "# test\n")
      sh(`git -C ${dir} add README.md`)
      sh(`git -C ${dir} commit -m init`)
      // No remote added

      await mod.ensureWorkspace({ directory: dir })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.worktree === dir)
      expect(proj).toBeDefined()
      expect(proj!.name).toBe("no-remote-proj")
    })

    test("two different repos create two separate projects", async () => {
      const gitA = await repo("service-a")
      const gitB = await repo("service-b")

      await mod.ensureWorkspace({ directory: gitA.dir })
      await mod.ensureWorkspace({ directory: gitB.dir })

      const projects = await mod.listProjects()
      const projA = projects.find((p) => p.git.repo === "service-a")
      const projB = projects.find((p) => p.git.repo === "service-b")

      expect(projA).toBeDefined()
      expect(projB).toBeDefined()
      expect(projA!.id).not.toBe(projB!.id)
    })

    test("re-ensuring the same directory does not create a duplicate project", async () => {
      const git = await repo("dedup-proj")

      await mod.ensureWorkspace({ directory: git.dir })
      await mod.ensureWorkspace({ directory: git.dir })
      await mod.ensureWorkspace({ directory: git.dir })

      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.git.repo === "dedup-proj")
      expect(matching).toHaveLength(1)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 9. Adding a local workspace (worktree) under a project
  // ────────────────────────────────────────────────────────────────────────

  describe("adding a local workspace (worktree)", () => {
    test("git worktree shares project_id with its parent repo", async () => {
      const git = await repo("wt-parent")

      // Main checkout
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))

      // Git worktree (sandbox) — simulates what POST /experimental/worktree does
      const wt = defined(await mod.ensureWorkspace({
        project_id: main.project_id,
        project_name: main.project_name,
        workspace_name: "feature-branch",
        directory: git.sb,
      }))

      expect(wt.project_id).toBe(main.project_id)
      expect(wt.id).not.toBe(main.id)
    })

    test("local worktree has kind=local", async () => {
      const git = await repo("wt-kind")

      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const wt = defined(await mod.ensureWorkspace({
        project_id: main.project_id,
        workspace_name: "fix-123",
        directory: git.sb,
      }))

      expect(wt.kind).toBe("local")
    })

    test("local worktree appears as sandbox under the same project, not as separate project", async () => {
      const git = await repo("wt-grouping")

      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      await mod.ensureWorkspace({
        project_id: main.project_id,
        workspace_name: "feature",
        directory: git.sb,
      })

      const projects = await mod.listProjects()

      // Must be exactly one project for this repo
      const matching = projects.filter((p) => p.git.repo === "wt-grouping")
      expect(matching).toHaveLength(1)

      const proj = matching[0]!
      // Main checkout is the worktree
      expect(proj.worktree).toBe(git.dir)
      // Git worktree is a sandbox
      expect(proj.sandboxes).toContain(git.sb)
    })

    test("local worktree inherits git metadata from the same repo", async () => {
      const git = await repo("wt-meta")

      await mod.ensureWorkspace({ directory: git.dir })
      const wt = defined(await mod.ensureWorkspace({
        project_id: defined(await mod.getWorkspaceByDirectory(git.dir)).project_id,
        directory: git.sb,
      }))

      // Both share the same repo_key (git common dir)
      const main = defined(await mod.getWorkspaceByDirectory(git.dir))
      expect(wt.repo_key).toBe(main.repo_key)
      expect(wt.git_remote).toBe("https://github.com/acme/wt-meta.git")
    })

    test("multiple local worktrees all group under one project", async () => {
      const dir = path.join(root, "repos", "multi-wt")
      const sb1 = path.join(root, "repos", "multi-wt-sb1")
      const sb2 = path.join(root, "repos", "multi-wt-sb2")
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, "README.md"), "# test\n")
      sh(`git init -b main ${dir}`)
      sh(`git -C ${dir} config user.email test@example.com`)
      sh(`git -C ${dir} config user.name test`)
      sh(`git -C ${dir} remote add origin https://github.com/acme/multi-wt.git`)
      sh(`git -C ${dir} add README.md`)
      sh(`git -C ${dir} commit -m init`)
      sh(`git -C ${dir} worktree add ${sb1}`)
      sh(`git -C ${dir} worktree add ${sb2}`)

      const main = defined(await mod.ensureWorkspace({ directory: dir }))
      await mod.ensureWorkspace({
        project_id: main.project_id,
        workspace_name: "wt1",
        directory: sb1,
      })
      await mod.ensureWorkspace({
        project_id: main.project_id,
        workspace_name: "wt2",
        directory: sb2,
      })

      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.git.repo === "multi-wt")
      expect(matching).toHaveLength(1)

      const proj = matching[0]!
      expect(proj.worktree).toBe(dir)
      expect(proj.sandboxes).toContain(sb1)
      expect(proj.sandboxes).toContain(sb2)
      expect(proj.sandboxes).toHaveLength(2)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 10. Adding a cloud workspace under a project
  // ────────────────────────────────────────────────────────────────────────

  describe("adding a cloud workspace under a project", () => {
    test("cloud workspace with explicit project_id groups under that project", async () => {
      const git = await repo("cloud-grp")

      // Create the project via local checkout
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      // Create cloud workspace under same project (simulates POST /create with projectId)
      const cloudDir = path.join(root, "cloud", "workspaces", projectId, "main")
      await fs.mkdir(cloudDir, { recursive: true })
      const cloud = defined(await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: projectId,
        project_name: "cloud-grp",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      }))

      expect(cloud.kind).toBe("cloud")
      expect(cloud.project_id).toBe(projectId)

      // Must be one project, not two
      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)
    })

    test("cloud workspace appears as sandbox, not as project worktree", async () => {
      const git = await repo("cloud-sandbox")

      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      const cloudDir = path.join(root, "cloud", "workspaces", projectId, "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: projectId,
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === projectId)
      expect(proj).toBeDefined()

      // Local checkout is the project worktree
      expect(proj!.worktree).toBe(git.dir)
      // Cloud workspace is a sandbox
      expect(proj!.sandboxes).toContain(cloudDir)
      // Not the other way around
      expect(proj!.sandboxes).not.toContain(git.dir)
    })

    test("cloud workspace has kind=cloud and provider set", async () => {
      const git = await repo("cloud-kind")
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))

      const cloudDir = path.join(root, "cloud", "workspaces", main.project_id!, "dev")
      await fs.mkdir(cloudDir, { recursive: true })
      const cloud = defined(await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: main.project_id!,
        workspace_name: "dev",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      }))

      expect(cloud.kind).toBe("cloud")
      expect(cloud.provider).toBe("daytona")
      expect(cloud.remote_directory).toBe("/workspace")
    })

    test("cloud workspace remote_directory does not become a separate workspace", async () => {
      const git = await repo("cloud-no-leak")
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))

      const cloudDir = path.join(root, "cloud", "workspaces", main.project_id!, "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: main.project_id!,
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        remote_directory: "/workspace",
      })

      // /workspace must not exist as a workspace
      const ws = await mod.getWorkspaceByDirectory("/workspace")
      expect(ws).toBeUndefined()

      // Only two workspaces total
      const all = await mod.listWorkspaces()
      expect(all).toHaveLength(2)
      expect(all.map((w) => w.directory).sort()).toEqual([cloudDir, git.dir].sort())
    })

    test("multiple cloud workspaces under one project", async () => {
      const git = await repo("cloud-multi")
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      const cloudMain = path.join(root, "cloud", "workspaces", projectId, "main")
      const cloudDev = path.join(root, "cloud", "workspaces", projectId, "dev")
      await fs.mkdir(cloudMain, { recursive: true })
      await fs.mkdir(cloudDev, { recursive: true })

      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}a`,
        project_id: projectId,
        workspace_name: "main",
        directory: cloudMain,
        kind: "cloud",
        provider: "daytona",
      })
      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}b`,
        project_id: projectId,
        workspace_name: "dev",
        directory: cloudDev,
        kind: "cloud",
        provider: "daytona",
      })

      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)

      const proj = matching[0]!
      // Local is worktree, both cloud dirs are sandboxes
      expect(proj.worktree).toBe(git.dir)
      expect(proj.sandboxes).toContain(cloudMain)
      expect(proj.sandboxes).toContain(cloudDev)
      expect(proj.sandboxes).toHaveLength(2)
    })

    test("cloud-first project: cloud workspace created before local checkout", async () => {
      // User creates a cloud sandbox first (new project, no local checkout yet)
      const projectId = `ws_${Date.now().toString(36)}`
      const cloudDir = path.join(root, "cloud", "workspaces", projectId, "main")
      await fs.mkdir(cloudDir, { recursive: true })

      await mod.ensureWorkspace({
        workspaceId: projectId,
        project_id: projectId,
        project_name: "NewApp",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        repo_url: "https://github.com/acme/new-app.git",
        remote_directory: "/workspace",
      })

      // At this point, project exists with one cloud workspace
      let projects = await mod.listProjects()
      let proj = projects.find((p) => p.id === projectId)
      expect(proj).toBeDefined()
      expect(proj!.worktree).toBe(cloudDir)
      expect(proj!.name).toBe("NewApp")

      // Now user clones locally and opens it
      const git = await repo("new-app")
      await mod.ensureWorkspace({
        project_id: projectId,
        directory: git.dir,
      })

      // After local checkout is added, it should group under same project
      projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)

      proj = matching[0]!
      // Both directories are in the project
      const allDirs = [proj.worktree, ...proj.sandboxes]
      expect(allDirs).toContain(git.dir)
      expect(allDirs).toContain(cloudDir)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 11. Re-adding a project after closing deduplicates and recovers all workspaces
  // ────────────────────────────────────────────────────────────────────────

  describe("re-adding a closed project", () => {
    test("re-ensuring the same directory after delete returns the same project with all workspaces", async () => {
      const git = await repo("reopen-proj")

      // Create project with main + local worktree + cloud sandbox
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      await mod.ensureWorkspace({
        project_id: projectId,
        workspace_name: "feature",
        directory: git.sb,
      })
      const cloudDir = path.join(root, "cloud", "workspaces", projectId, "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: projectId,
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
      })

      // Verify: 3 workspaces, 1 project
      let projects = await mod.listProjects()
      let proj = projects.find((p) => p.id === projectId)
      expect(proj).toBeDefined()
      const originalSandboxCount = proj!.sandboxes.length
      expect(originalSandboxCount).toBe(2) // worktree + cloud

      // "Close" is frontend-only (localStorage), workspace-store is untouched.
      // Re-ensure the main directory — simulates user re-opening the project.
      const reopened = defined(await mod.ensureWorkspace({ directory: git.dir }))

      // Same workspace, same project_id — no duplicate
      expect(reopened.id).toBe(main.id)
      expect(reopened.project_id).toBe(projectId)

      // listProjects still returns exactly one project with all workspaces
      projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)
      expect(matching[0]!.sandboxes).toHaveLength(originalSandboxCount)
    })

    test("re-ensuring via resolveWorkspace(create=true) deduplicates", async () => {
      const git = await repo("resolve-reopen")

      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      // Add a worktree
      await mod.ensureWorkspace({
        project_id: projectId,
        workspace_name: "hotfix",
        directory: git.sb,
      })

      // Re-resolve with create=true (this is what the frontend does)
      const resolved = await mod.resolveWorkspace({
        directory: git.dir,
        create: true,
      })

      // Must return the existing workspace, not a new one
      expect(resolved).toBeDefined()
      expect(resolved!.id).toBe(main.id)
      expect(resolved!.project_id).toBe(projectId)

      // No duplicate workspaces or projects
      const all = await mod.listWorkspaces()
      const forProject = all.filter((w) => w.project_id === projectId)
      expect(forProject).toHaveLength(2) // main + hotfix

      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)
    })

    test("listProjects recovers all workspaces regardless of creation order", async () => {
      // Simulate: cloud sandbox created, then local added later, then project
      // is "closed" (frontend only), then user navigates back to the directory.
      // All workspaces must still be grouped correctly.
      const git = await repo("recover-all")
      const projectId = "proj_recover"

      // Cloud first
      const cloudDir = path.join(root, "cloud", "workspaces", projectId, "main")
      await fs.mkdir(cloudDir, { recursive: true })
      await mod.ensureWorkspace({
        workspaceId: `ws_${Date.now().toString(36)}`,
        project_id: projectId,
        project_name: "recover-all",
        workspace_name: "main",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
      })

      // Local checkout added later
      await mod.ensureWorkspace({
        project_id: projectId,
        directory: git.dir,
      })

      // Local worktree added
      await mod.ensureWorkspace({
        project_id: projectId,
        workspace_name: "experiment",
        directory: git.sb,
      })

      // "Close" happens in frontend. Re-open by re-ensuring main dir.
      await mod.ensureWorkspace({ directory: git.dir })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === projectId)
      expect(proj).toBeDefined()

      // All 3 directories must be accounted for (1 worktree + 2 sandboxes)
      const allDirs = [proj!.worktree, ...proj!.sandboxes]
      expect(allDirs).toHaveLength(3)
      expect(allDirs).toContain(git.dir)
      expect(allDirs).toContain(git.sb)
      expect(allDirs).toContain(cloudDir)
    })

    test("workspace count does not grow on repeated re-ensures", async () => {
      const git = await repo("no-growth")
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      await mod.ensureWorkspace({
        project_id: projectId,
        workspace_name: "wt1",
        directory: git.sb,
      })

      // Re-ensure both multiple times (simulates repeated open/close cycles)
      for (let i = 0; i < 5; i++) {
        await mod.ensureWorkspace({ directory: git.dir })
        await mod.ensureWorkspace({ directory: git.sb })
      }

      const all = await mod.listWorkspaces()
      const forProject = all.filter((w) => w.project_id === projectId)
      expect(forProject).toHaveLength(2) // still just 2

      const projects = await mod.listProjects()
      const matching = projects.filter((p) => p.id === projectId)
      expect(matching).toHaveLength(1)
      expect(matching[0]!.sandboxes).toHaveLength(1)
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  // 12. Non-git directories must be rejected
  // ────────────────────────────────────────────────────────────────────────

  describe("non-git directory rejection", () => {
    test("resolveWorkspace with create=true rejects non-git directory", async () => {
      // Use /tmp to avoid parent git repo detection
      const dir = `/tmp/ws-integrity-no-git-${randomUUID().slice(0, 8)}`
      await fs.mkdir(dir, { recursive: true })
      try {
        const ws = await mod.resolveWorkspace({ directory: dir, create: true })
        expect(ws).toBeUndefined()

        const all = await mod.listWorkspaces()
        const hit = all.find((w) => w.directory === dir)
        expect(hit).toBeUndefined()
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })

    test("resolveWorkspace with create=true rejects nested non-git directory", async () => {
      const dir = `/tmp/ws-integrity-nested-${randomUUID().slice(0, 8)}/deep/nested`
      await fs.mkdir(dir, { recursive: true })
      try {
        const ws = await mod.resolveWorkspace({ directory: dir, create: true })
        expect(ws).toBeUndefined()
      } finally {
        await fs.rm(dir.split("/").slice(0, 4).join("/"), { recursive: true, force: true })
      }
    })

    test("resolveWorkspace with create=true accepts git directory", async () => {
      const git = await repo("resolve-git-ok")

      const ws = await mod.resolveWorkspace({ directory: git.dir, create: true })
      expect(ws).toBeDefined()
      expect(ws!.repo_key).toBeDefined()

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.git.repo === "resolve-git-ok")
      expect(proj).toBeDefined()
    })

    test("cloud workspace is allowed without local git via ensureWorkspace", async () => {
      const cloudDir = path.join(root, "cloud", "no-git-cloud")
      await fs.mkdir(cloudDir, { recursive: true })

      const ws = await mod.ensureWorkspace({
        workspaceId: "ws_no_git_cloud",
        project_id: "proj_no_git",
        directory: cloudDir,
        kind: "cloud",
        provider: "daytona",
        repo_url: "https://github.com/acme/app.git",
      })

      expect(ws).toBeDefined()
      expect(ws!.kind).toBe("cloud")
    })

    test("subdirectory workspace does not appear as sandbox in listProjects", async () => {
      const git = await repo("subdir-test")

      // Create the root workspace
      const main = defined(await mod.ensureWorkspace({ directory: git.dir }))
      const projectId = main.project_id!

      // Simulate opening a session from a subdirectory (e.g. packages/claxedo-server)
      const subdir = path.join(git.dir, "packages", "server")
      await fs.mkdir(subdir, { recursive: true })
      await mod.ensureWorkspace({
        project_id: projectId,
        directory: subdir,
      })

      const projects = await mod.listProjects()
      const proj = projects.find((p) => p.id === projectId)
      expect(proj).toBeDefined()

      // Subdirectory must NOT appear as a sandbox
      expect(proj!.sandboxes).not.toContain(subdir)
      // Only the root worktree should be in the project
      expect(proj!.worktree).toBe(git.dir)
      expect(proj!.sandboxes).toHaveLength(0)
    })

    test("resolveWorkspace without create does not reject non-git (lookup only)", async () => {
      const dir = path.join(root, "repos", "no-git-lookup")
      await fs.mkdir(dir, { recursive: true })

      // Just a lookup — no creation, no rejection
      const ws = await mod.resolveWorkspace({ directory: dir })
      expect(ws).toBeUndefined() // not found, but no error
    })
  })
})
