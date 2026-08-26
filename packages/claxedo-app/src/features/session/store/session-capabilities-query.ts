import type { Accessor } from "solid-js"
import { queryClient } from "@/platform/query/query-client"
import { setSessionCapabilitiesQueryData } from "../data/sync/writers"
import { shouldAcceptSessionTransportResult } from "./session-history-activation"
import { sessionCapabilitiesKey } from "./session-pane-queries"
import { fetchSessionCapabilitiesByTransport } from "./session-transport"
import { leasedQueryRequest, leasedQueryRequestKey } from "./leased-query-request"
import { sessionResourceAuthorityKey } from "./session-resource-authority"

type SessionCapabilitiesTransportRequest = Omit<
  Parameters<typeof fetchSessionCapabilitiesByTransport>[0],
  "signal"
>

function sessionCapabilitiesTransportRequestScope(input: SessionCapabilitiesTransportRequest) {
  return [
    "runtime",
    "session-capabilities-request",
    sessionResourceAuthorityKey({
      sessionID: input.sessionID ?? "",
      directory: input.directory,
      serverUrl: input.claxedoServerUrl,
      signedControlPlane: input.signedControlPlane,
      workspaceId: input.workspaceId,
      workspaceKind: input.workspaceKind,
      sessionRef: input.sessionRef,
    }),
  ] as const
}

export function sessionCapabilitiesTransportRequestKey(input: SessionCapabilitiesTransportRequest) {
  return leasedQueryRequestKey(sessionCapabilitiesTransportRequestScope(input), input.client)
}

async function fetchSessionCapabilitiesRequest(
  request: SessionCapabilitiesTransportRequest,
  consumerSignal?: AbortSignal,
) {
  return await leasedQueryRequest({
    scopeKey: sessionCapabilitiesTransportRequestScope(request),
    authority: request.client,
    signal: consumerSignal,
    queryFn: (signal) => fetchSessionCapabilitiesByTransport({
      ...request,
      signal,
    }),
  })
}

export async function syncSessionCapabilitiesData(input: {
  request: SessionCapabilitiesTransportRequest & { sessionID: string }
  currentSessionID: Accessor<string | undefined>
  currentDirectory: Accessor<string | undefined>
  signal?: AbortSignal
}) {
  try {
    const capabilities = await fetchSessionCapabilitiesRequest(input.request, input.signal)
    if (input.signal?.aborted) return false
    if (!shouldAcceptSessionTransportResult({
      expectedSessionID: input.request.sessionID,
      currentSessionID: input.currentSessionID(),
      expectedDirectory: input.request.directory,
      currentDirectory: input.currentDirectory(),
    })) return false
    setSessionCapabilitiesQueryData({
      queryClient,
      queryKey: sessionCapabilitiesKey({
        sessionID: input.request.sessionID,
        directory: input.request.directory,
        serverUrl: input.request.claxedoServerUrl,
        signedControlPlane: input.request.signedControlPlane,
        workspaceId: input.request.workspaceId,
        workspaceKind: input.request.workspaceKind,
        sessionRef: input.request.sessionRef,
      }),
      capabilities,
    })
    return true
  } catch (error) {
    if (input.signal?.aborted) return false
    throw error
  }
}
