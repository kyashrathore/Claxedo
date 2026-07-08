import type { AgentHarnessId } from "@claxedo/agent-sdk-runtime"
import type { WorkspaceProfile } from "@claxedo/workspace-runtime/host"

export type HarnessMode = "workspace"
export type HarnessHost = "workspace" | "central"
export type SessionWriteMode = "workspace_replicated" | "central_canonical"

export function harnessHostForHarness(_harness?: { id?: AgentHarnessId | null } | null): HarnessHost {
  return "workspace"
}

export function workspaceProfileForHarness(_harness?: { id?: AgentHarnessId | null } | null): WorkspaceProfile {
  return "workspace"
}

export function getHarnessMode(): HarnessMode {
  return "workspace"
}

export function getWorkspaceProfile(): WorkspaceProfile {
  return workspaceProfileForHarness({ id: "opencode" })
}

export function getSessionWriteMode(_input?: { id?: AgentHarnessId | null } | null): SessionWriteMode {
  return "workspace_replicated"
}
