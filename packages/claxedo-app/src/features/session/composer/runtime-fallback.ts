import { submitTransportForPlacement } from "@/platform/runtime/transport"

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
    model: () => undefined,
    agent: () => active(input.directory()) ? { name: "build" } : undefined,
  }
}
