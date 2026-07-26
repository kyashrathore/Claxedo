// The SDK scope's runtime-request wrapper cache.
//
// This lives outside `sdk.tsx` on purpose. `sdk.tsx` is one of the modules test
// files stub wholesale with `mock.module("@/app/providers/sdk/sdk", ...)` to
// avoid pulling the provider's whole graph into a unit test — and bun's module
// registry is process-wide, so the first stub to run replaces the module for
// every later file in the same `bun test` process. A test that needs the real
// dedupe helpers would then fail with "Export named ... not found", depending
// on file order. Keeping them in their own module means stubbing the provider
// never shadows them.
import { queryClient } from "@/platform/query/query-client"
import { fastSessionSwitchAnyNetworkQuiet } from "@/platform/runtime/session-switch"
import {
  centralTransportForServer,
  createTransport,
  type RuntimeTransport,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeSnapshotLike,
} from "@/platform/runtime/transport"

export type SdkRuntimeRequestInput = {
  serverUrl?: string
  directory?: string
  workspaceId?: string
  workspace?: WorkspaceRuntimeSnapshotLike
  request?: typeof fetch
  relayRequest?: typeof fetch
  resolveWorkspaceRuntime?: WorkspaceRuntimeRequestOptions["resolveWorkspaceRuntime"]
}

const sdkRuntimeRequestQueryRoot = ["shell", "sdk-runtime-request"] as const

export function sdkRuntimeRequestQueryKey(input: {
  owner: string
  serverUrl?: string
  directory?: string
  workspaceId?: string
}) {
  return [
    ...sdkRuntimeRequestQueryRoot,
    input.owner,
    input.serverUrl ?? "",
    input.directory ?? "",
    input.workspaceId ?? "",
  ] as const
}

export function resetSdkRuntimeRequestCacheForTest() {
  queryClient.removeQueries({ queryKey: sdkRuntimeRequestQueryRoot })
}

export function cachedSdkRuntimeRequest(input: SdkRuntimeRequestInput & { owner: string }) {
  const queryKey = sdkRuntimeRequestQueryKey({
    owner: input.owner,
    serverUrl: input.serverUrl,
    directory: input.directory,
    workspaceId: input.workspaceId,
  })
  const cached = queryClient.getQueryData<RuntimeTransport>(queryKey)
  if (cached) return cached
  const next = createTransport({
    placement: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      hosting: "workspace",
      transport: input.workspaceId && centralTransportForServer(input.serverUrl) !== "loopback" ? "workspace-relay" : "loopback",
    },
    serverUrl: input.serverUrl,
    directory: input.directory,
    request: input.request,
    relayRequest: input.relayRequest,
    resolveWorkspaceRuntime: fastSessionSwitchAnyNetworkQuiet() && input.directory && !input.workspaceId
      ? async () => null
      : input.resolveWorkspaceRuntime,
  })
  queryClient.setQueryData(queryKey, next)
  return next
}
