import fs from "fs"
import path from "path"
import { dataDir } from "./paths"
import { harnessMode, workspaceProfile, type HarnessMode, type WorkspaceProfile } from "../../workspace-runtime/src/profile"

export type SessionWriteMode = "workspace_replicated" | "central_canonical"

const file = path.join(dataDir(), "user-agent-config.json")

function read() {
  const env = process.env.CLAXEDO_HARNESS_MODE
  if (env) return harnessMode(env)
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      harness?: {
        mode?: string
      }
    }
    return harnessMode(raw.harness?.mode)
  } catch {
    return "workspace" as const
  }
}

let mode = read()

export function configureHarnessMode(next?: HarnessMode) {
  mode = next ? harnessMode(next) : read()
  return mode
}

export function getHarnessMode(): HarnessMode {
  return mode
}

export function getWorkspaceProfile(): WorkspaceProfile {
  return workspaceProfile(mode)
}

export function getSessionWriteMode(): SessionWriteMode {
  return mode === "central" ? "central_canonical" : "workspace_replicated"
}
