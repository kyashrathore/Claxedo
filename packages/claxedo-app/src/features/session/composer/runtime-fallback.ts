import { submitTransportForPlacement } from "@/platform/runtime/transport"
import { SIGNED_WORKSPACE_DEFAULT_MODEL } from "./signed-workspace-model"

export function createSignedWorkspaceRuntimeFallback(input: {
  serverUrl: () => string
  directory: () => string
  signedControlPlane: () => boolean
  workspaceId?: () => string | undefined
  workspaceKind?: () => "cloud" | "user-hosted" | undefined
}) {
  const active = (directory: string) =>
    input.signedControlPlane() && submitTransportForPlacement({
      serverUrl: input.serverUrl(),
      directory,
      signedControlPlane: input.signedControlPlane(),
      workspaceId: input.workspaceId?.(),
      workspaceKind: input.workspaceKind?.(),
    }).workspaceRuntimeSession

  return {
    model: () => {
      if (!active(input.directory())) return undefined
      return { ...SIGNED_WORKSPACE_DEFAULT_MODEL }
    },
    agent: () => active(input.directory()) ? { name: "build" } : undefined,
  }
}
