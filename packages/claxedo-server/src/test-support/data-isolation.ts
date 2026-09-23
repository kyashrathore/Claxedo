import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll } from "vitest"

/**
 * Every data root this package can reach resolves from `os.homedir()` when its
 * environment variable is absent: `~/.claxedo` (server-core `dataDir()`, which
 * carries `claxedo.db` and `authority.db`) and `~/.workspace-runtime`
 * (workspace-runtime `workspaceRuntimeDataDir()`, aliased to source by
 * `vitest.config.ts`). A test that opens the database therefore migrates and
 * writes the developer's own profile unless something redirects it first.
 *
 * A setup file is the only hook early enough: it runs before the test file's
 * module graph is imported, so a store opened from a top-level import — ahead
 * of any `beforeAll` — already reads a temporary directory.
 *
 * Root assignment is unconditional. Remove inherited leaf overrides so the
 * canonical path resolvers derive them from these roots, including when a
 * test deliberately selects a different temporary data root.
 */
const root = mkdtempSync(path.join(realpathSync(tmpdir()), "claxedo-server-vitest-"))

const claxedo = path.join(root, "claxedo")
const workspaceRuntime = path.join(root, "workspace-runtime")

process.env.CLAXEDO_DATA_DIR = claxedo
process.env.WORKSPACE_RUNTIME_DATA_DIR = workspaceRuntime
process.env.WORKSPACE_RUNTIME_WORKSPACES_DIR = path.join(root, "workspaces")
for (const key of [
  "CLAXEDO_STATE_DIR",
  "CLAXEDO_WAKE_DB_PATH",
  "WORKSPACE_RUNTIME_STATE_DIR",
  "WORKSPACE_RUNTIME_STORE_DIR",
  "WORKSPACE_RUNTIME_PTY_HISTORY_DIR",
]) delete process.env[key]

afterAll(async () => {
  const { removeTestDataDir } = await import("./test-data-dir")
  removeTestDataDir(root)
})
