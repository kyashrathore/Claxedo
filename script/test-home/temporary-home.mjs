import os from "node:os"
import path from "node:path"

const TEST_HOME_ENV = "CLAXEDO_TEST_HOME"

const XDG_BASE_DIRS = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: path.join(".local", "share"),
  XDG_STATE_HOME: path.join(".local", "state"),
  XDG_CACHE_HOME: ".cache",
}

const HOME_OVERRIDES = [
  "CLAXEDO_HOME",
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_STATE_DIR",
  "WORKSPACE_RUNTIME_DATA_DIR",
  "WORKSPACE_RUNTIME_STATE_DIR",
  "WORKSPACE_RUNTIME_STORE_DIR",
  "WORKSPACE_RUNTIME_PTY_HISTORY_DIR",
  "WORKSPACE_RUNTIME_WORKSPACES_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_HOME",
]

export const HOME_STATE_ENV = [...HOME_OVERRIDES, ...Object.keys(XDG_BASE_DIRS)]

export function temporaryHomeEnv(home, inherited) {
  const env = { ...inherited, HOME: home, USERPROFILE: home, [TEST_HOME_ENV]: home }
  for (const key of HOME_OVERRIDES) delete env[key]
  for (const [key, relative] of Object.entries(XDG_BASE_DIRS)) env[key] = path.join(home, relative)
  return env
}

export function assertTemporaryHome() {
  const home = process.env[TEST_HOME_ENV]
  if (home && os.homedir() === home && process.env.XDG_CONFIG_HOME?.startsWith(home)) return
  throw new Error(`Tests run in a temporary home, never ${os.homedir()}: start them through script/test-home/run.mjs`)
}
