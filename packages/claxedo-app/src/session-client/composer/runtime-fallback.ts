import { submitTransportForPlacement } from "../../shell/data/transport/transport"

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
      return {
        id: "big-pickle",
        name: "Big Pickle",
        provider: { id: "opencode" },
      }
    },
    agent: () => active(input.directory()) ? { name: "build" } : undefined,
  }
}
