import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeTestTempDir } from "../harnesses/shared/test-temp-dir"

/**
 * Names that move a harness's transcripts, sessions and config away from the
 * home directory. A spawned CLI inherits this process's environment, so any
 * one of these left set sends a test turn to the developer's real state, where
 * Claxedo's usage scanner reads it as their usage.
 */
const HARNESS_HOME_OVERRIDES = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_HOME",
]

/**
 * Assigned rather than removed: OpenCode's embedded engine resolves these
 * in-process, falling back to `os.homedir()`, which Bun 1.3 snapshotted at
 * startup — before this file set HOME.
 */
const XDG_BASE_DIRS = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: path.join(".local", "share"),
  XDG_STATE_HOME: path.join(".local", "state"),
  XDG_CACHE_HOME: ".cache",
}

export const HARNESS_STATE_ENV = [...HARNESS_HOME_OVERRIDES, ...Object.keys(XDG_BASE_DIRS)]

/**
 * Preloaded ahead of the test module graph, because modules capture home-derived
 * roots in constants at import time.
 */
const home = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-test-home-"))

process.env.HOME = home
process.env.USERPROFILE = home
for (const key of HARNESS_HOME_OVERRIDES) delete process.env[key]
for (const [key, relative] of Object.entries(XDG_BASE_DIRS)) process.env[key] = path.join(home, relative)

const cleanup = () => removeTestTempDir(home)
// `bun test` 1.3.14 runs no exit listeners; Node's test runner has no `bun:test`.
if (process.versions.bun) (await import("bun:test")).afterAll(cleanup)
else process.on("exit", cleanup)
