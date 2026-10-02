import path from "node:path"

const HARNESS_HOME_OVERRIDES = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "PI_CODING_AGENT_DIR",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_TEST_HOME",
]

const XDG_BASE_DIRS = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: path.join(".local", "share"),
  XDG_STATE_HOME: path.join(".local", "state"),
  XDG_CACHE_HOME: ".cache",
}

export const HARNESS_STATE_ENV = [...HARNESS_HOME_OVERRIDES, ...Object.keys(XDG_BASE_DIRS)]

export function isolateHarnessHome(home) {
  process.env.HOME = home
  process.env.USERPROFILE = home
  for (const key of HARNESS_HOME_OVERRIDES) delete process.env[key]
  for (const [key, relative] of Object.entries(XDG_BASE_DIRS)) process.env[key] = path.join(home, relative)
}
