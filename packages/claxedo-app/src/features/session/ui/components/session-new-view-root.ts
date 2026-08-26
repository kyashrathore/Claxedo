import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"

export function newSessionProjectRoot(input: { sdkDirectory: string; projectWorktree?: string }) {
  if (sessionWorkspaceRuntimeRef({ directory: input.sdkDirectory })) {
    return input.sdkDirectory
  }
  return input.projectWorktree ?? input.sdkDirectory
}
