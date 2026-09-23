import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * `setupAgentHooks()` rewrites the harness configs under the user's home
 * (`~/.codex/hooks.json`, `~/.cursor/hooks.json`, `~/.claude/settings.json`,
 * ...) and the runtime data root defaults to `~/.workspace-runtime`, so any
 * test that starts a server would otherwise edit the developer's own profile.
 *
 * Preloaded before the test module graph: `CLAXEDO_DIR` is a module-level
 * constant, so the data root must already resolve here when it is imported.
 * Inherited data-root overrides are removed so every path derives from this
 * home.
 */
const home = mkdtempSync(path.join(realpathSync(tmpdir()), "workspace-runtime-test-home-"))

process.env.HOME = home
process.env.USERPROFILE = home
for (const key of [
  "WORKSPACE_RUNTIME_DATA_DIR",
  "WORKSPACE_RUNTIME_STATE_DIR",
  "WORKSPACE_RUNTIME_STORE_DIR",
  "WORKSPACE_RUNTIME_PTY_HISTORY_DIR",
  "WORKSPACE_RUNTIME_WORKSPACES_DIR",
]) delete process.env[key]

process.on("exit", () => rmSync(home, { recursive: true, force: true }))
