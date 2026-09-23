import { centralTransportForServer } from "@/platform/runtime/transport"

export function shouldBlockRemoteSessionHistoryAction(input: {
  serverUrl?: string
}) {
  return centralTransportForServer(input.serverUrl) !== "loopback"
}

export function sessionSelectionRoute(input: {
  sessionId: string
  canonicalRoute: (sessionId: string) => string
}) {
  return input.canonicalRoute(input.sessionId)
}
