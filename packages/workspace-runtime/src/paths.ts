import { workspaceRuntimeDataDir, workspaceRuntimeStateDir } from "./env"

export function dataDir(): string {
  return workspaceRuntimeDataDir()
}

export function stateDir(): string {
  return workspaceRuntimeStateDir()
}
