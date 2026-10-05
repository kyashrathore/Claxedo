import os from "node:os"
import path from "node:path"

export const TEMPORARY_HOME_ENV = "CLAXEDO_HARNESS_TEST_HOME"

const XDG_BASE_DIRS = {
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: path.join(".local", "share"),
  XDG_STATE_HOME: path.join(".local", "state"),
  XDG_CACHE_HOME: ".cache",
}

const HARNESS_HOME_OVERRIDES = [
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "PI_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_TEST_HOME",
]

export function temporaryHomeEnv(home: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: home, USERPROFILE: home, [TEMPORARY_HOME_ENV]: home }
  for (const key of HARNESS_HOME_OVERRIDES) delete env[key]
  for (const [key, relative] of Object.entries(XDG_BASE_DIRS)) env[key] = path.join(home, relative)
  return env
}

export function assertTemporaryHome(): void {
  const home = process.env[TEMPORARY_HOME_ENV]
  if (home && os.homedir() === home && process.env.XDG_CONFIG_HOME?.startsWith(home)) return
  throw new Error(`Harness tests run in a temporary home, never ${os.homedir()}: run them with \`bun run test:files <paths>\``)
}
