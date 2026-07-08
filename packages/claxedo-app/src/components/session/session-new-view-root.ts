import { sessionWorkspaceRuntimeRef } from "../../shell/workspace/session-workspace-key"

export function newSessionProjectRoot(input: {
  sdkDirectory: string
  projectWorktree?: string
}) {
  if (sessionWorkspaceRuntimeRef({ directory: input.sdkDirectory })) {
    return input.sdkDirectory
  }
  return input.projectWorktree ?? input.sdkDirectory
}
