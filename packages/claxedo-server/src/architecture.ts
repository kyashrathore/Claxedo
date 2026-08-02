import type { WorkspaceProfile } from "@claxedo/workspace-runtime/host"

export type HarnessMode = "workspace"
export type HarnessHost = "workspace" | "central"
export type SessionWriteMode = "workspace_replicated" | "central_canonical"

export function getHarnessMode(): HarnessMode {
  return "workspace"
}

export function getWorkspaceProfile(): WorkspaceProfile {
  return "workspace"
}

export function getSessionWriteMode(): SessionWriteMode {
  return "workspace_replicated"
}
