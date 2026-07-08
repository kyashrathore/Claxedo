import { afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  configureEmbeddedWorkspaceRuntime,
  ensureEmbeddedWorkspaceRuntime,
  shutdownEmbeddedWorkspaceRuntimes,
  syncEmbeddedWorkspaceRuntimeAgentExtensions,
} from "./embedded-workspace-runtime"
import type { Workspace } from "./workspace-store"

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
    created_at: 1,
    updated_at: 1,
  }
}

// apply() writes this file into the workspace directory as a side effect, so
// its presence distinguishes config mode "sync" (applied) from "skip".
async function applyStatusExists(directory: string) {
  return await fs
    .stat(path.join(directory, ".workspace-runtime", "runtime-config", "apply-status.json"))
    .then(() => true)
    .catch(() => false)
}

const previous = {
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_AGENT_TYPE: process.env.CLAXEDO_AGENT_TYPE,
  OPENCODE_URL: process.env.OPENCODE_URL,
}

afterEach(async () => {
  shutdownEmbeddedWorkspaceRuntimes()
  if (previous.CLAXEDO_DATA_DIR === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previous.CLAXEDO_DATA_DIR
  if (previous.CLAXEDO_AGENT_TYPE === undefined) delete process.env.CLAXEDO_AGENT_TYPE
  else process.env.CLAXEDO_AGENT_TYPE = previous.CLAXEDO_AGENT_TYPE
  if (previous.OPENCODE_URL === undefined) delete process.env.OPENCODE_URL
  else process.env.OPENCODE_URL = previous.OPENCODE_URL
})

describe("embedded workspace runtime", () => {
  test("applies signed workspace Agent Extension records to an active local host", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-embedded-ext-"))
    const project = path.join(root, "project")
    const extension = path.join(project, "extensions", "review")
    await fs.mkdir(extension, { recursive: true })
    await fs.writeFile(path.join(extension, "SKILL.md"), "---\nname: review\n---\n\n# Review\n")

    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    const workspace: Workspace = {
      id: "ws_embedded_extensions",
      directory: project,
      kind: "local",
      created_at: 1,
      updated_at: 1,
    }
    await ensureEmbeddedWorkspaceRuntime(workspace, { config: "skip" })

    await syncEmbeddedWorkspaceRuntimeAgentExtensions(workspace.id, [{
      desired: {
        id: "review",
        package_name: "review",
        source: {
          type: "project",
          package_path: "extensions/review",
        },
        scope: "workspace",
        enabled: true,
        targets: ["cursor"],
        installed_at: 10,
        updated_at: 10,
      },
    }])

    await expect(fs.readFile(path.join(project, ".cursor", "skills", "review", "SKILL.md"), "utf8"))
      .resolves.toContain("# Review")
    await expect(fs.readFile(path.join(project, ".agent-extensions", "materialized.json"), "utf8").then(JSON.parse))
      .resolves.toMatchObject({
        packages: {
          review: {
            status: "applied",
            components: [{
              runner: "cursor",
              type: "skill",
              status: "applied",
            }],
          },
        },
      })

    await fs.rm(root, { recursive: true, force: true })
  })

  // ── Characterization (Unit 1): cache-per-workspace-id, config mode,
  //    configure-affects-creation, shutdown clears the cache. ──────────────────
  test("caches one runtime per workspace id and recreates when the directory changes", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-cache-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_cache", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      const second = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      // Same workspace id + same directory → the cached runtime is reused.
      expect(second).toBe(first)

      const movedProject = path.join(root, "project-2")
      await fs.mkdir(movedProject, { recursive: true })
      const moved = await ensureEmbeddedWorkspaceRuntime(workspace("ws_cache", movedProject), { config: "skip" })
      // Same id but a different directory → the old runtime is disposed and a
      // fresh one is created.
      expect(moved).not.toBe(first)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("config mode 'skip' does not apply runtime config; 'sync' does", async () => {
    const skip = await makeWorkspaceRoot("claxedo-embedded-skip-")
    const sync = await makeWorkspaceRoot("claxedo-embedded-sync-")
    process.env.CLAXEDO_DATA_DIR = path.join(skip.root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      await ensureEmbeddedWorkspaceRuntime(workspace("ws_skip", skip.project), { config: "skip" })
      // "skip" leaves the workspace untouched: no runtime-config apply happened.
      expect(await applyStatusExists(skip.project)).toBe(false)

      await ensureEmbeddedWorkspaceRuntime(workspace("ws_sync", sync.project), { config: "sync" })
      // "sync" (the default) applies runtime config, which persists an
      // apply-status.json marker into the workspace directory.
      expect(await applyStatusExists(sync.project)).toBe(true)
    } finally {
      await fs.rm(skip.root, { recursive: true, force: true })
      await fs.rm(sync.root, { recursive: true, force: true })
    }
  })

  test("configureEmbeddedWorkspaceRuntime does not retroactively recreate a cached runtime", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-configure-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_configure", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      // Reconfiguring the module-level opencode target only affects NEW
      // creations; an already-cached runtime is not recreated.
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      const afterConfigure = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(afterConfigure).toBe(first)

      // A brand-new workspace created after reconfiguring gets its own runtime.
      const freshProject = project + "-new"
      await fs.mkdir(freshProject, { recursive: true })
      const fresh = await ensureEmbeddedWorkspaceRuntime(workspace("ws_configure_new", freshProject), {
        config: "skip",
      })
      expect(fresh).not.toBe(first)
    } finally {
      // Restore the default target so we do not leak the reconfigured URL into
      // other tests in this file.
      configureEmbeddedWorkspaceRuntime({ opencodeRequest: async () => new Response(null, { status: 404 }) })
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(project + "-new", { recursive: true, force: true }).catch(() => {})
    }
  })

  test("shutdownEmbeddedWorkspaceRuntimes clears the cache", async () => {
    const { root, project } = await makeWorkspaceRoot("claxedo-embedded-shutdown-")
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    process.env.CLAXEDO_AGENT_TYPE = "opencode"
    process.env.OPENCODE_URL = "http://opencode.test"

    try {
      const ws = workspace("ws_shutdown", project)
      const first = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })

      shutdownEmbeddedWorkspaceRuntimes()

      // After shutdown the cache is empty, so the next ensure builds a fresh
      // runtime rather than returning the disposed one.
      const rebuilt = await ensureEmbeddedWorkspaceRuntime(ws, { config: "skip" })
      expect(rebuilt).not.toBe(first)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
