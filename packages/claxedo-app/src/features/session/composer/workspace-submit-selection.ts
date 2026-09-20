import { asHostKind, isRelayHostKind } from "@/platform/runtime/placement-wire"

export type WorkspaceSubmitSelectionInput = {
  isNewSession: boolean
  draftId?: string
  projectDirectory?: string
  fallbackDirectory?: string
  defaultDirectory: string
  worktreeSelection: string
  hostKind: string
}

export type WorkspaceSubmitSelection =
  | { status: "ready"; directory: string }
  | { status: "missing-workspace" }
  | { status: "create-local-worktree"; baseDirectory?: string }
  | { status: "resolve-remote-workspace" }

/** Shared admission and selection policy before local creation or remote catalog resolution. */
export function resolveWorkspaceSubmitSelection(input: WorkspaceSubmitSelectionInput): WorkspaceSubmitSelection {
  const directory = input.projectDirectory ?? input.fallbackDirectory
  if (!input.isNewSession) return { status: "ready", directory: directory ?? input.defaultDirectory }
  if (input.draftId && !input.projectDirectory && input.worktreeSelection === "main") {
    return { status: "missing-workspace" }
  }
  if (isRelayHostKind(asHostKind(input.hostKind))) {
    return { status: "resolve-remote-workspace" }
  }
  if (input.worktreeSelection === "create") {
    return { status: "create-local-worktree", baseDirectory: directory }
  }
  if (input.worktreeSelection !== "main") return { status: "ready", directory: input.worktreeSelection }
  if (input.draftId && !directory) return { status: "missing-workspace" }
  return { status: "ready", directory: directory ?? input.defaultDirectory }
}
