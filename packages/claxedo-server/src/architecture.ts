import fs from "fs"
import path from "path"
import { dataDir } from "./paths"
import { defaultRunner, type RunnerType, type UserAgentConfig } from "./agent-config"
import type { WorkspaceProfile } from "../../workspace-runtime/src/profile"

export type HarnessMode = "workspace" | "central"
export type RunnerHost = HarnessMode
export type SessionWriteMode = "workspace_replicated" | "central_canonical"

const file = path.join(dataDir(), "user-agent-config.json")

function read() {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<UserAgentConfig>
  } catch {
    return {}
  }
}

export function runnerHostForRunner(runner?: { type?: RunnerType | null } | null): RunnerHost {
  return runner?.type === "pi" ? "central" : "workspace"
}

export function workspaceProfileForRunner(runner?: { type?: RunnerType | null } | null): WorkspaceProfile {
  return runnerHostForRunner(runner) === "central" ? "minimal" : "full"
}

export function getHarnessMode(): HarnessMode {
  const env = process.env.CLAXEDO_HARNESS_MODE
  if (env === "central") return "central"
  if (env === "workspace") return "workspace"
  const cfg = read()
  if (cfg.harness?.mode === "central") return "central"
  if (cfg.harness?.mode === "workspace") return "workspace"
  return runnerHostForRunner(defaultRunner(cfg as UserAgentConfig))
}

export function configureHarnessMode(next?: HarnessMode) {
  if (next) process.env.CLAXEDO_HARNESS_MODE = next
  return getHarnessMode()
}

export function getWorkspaceProfile(): WorkspaceProfile {
  return workspaceProfileForRunner({ type: getHarnessMode() === "central" ? "pi" : "opencode" })
}

export function getSessionWriteMode(input?: { type?: RunnerType | null } | null): SessionWriteMode {
  return runnerHostForRunner(input ?? { type: getHarnessMode() === "central" ? "pi" : "opencode" }) === "central"
    ? "central_canonical"
    : "workspace_replicated"
}
