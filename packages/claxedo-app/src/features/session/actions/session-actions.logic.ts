import { centralTransportForServer } from "@/platform/runtime/transport"
import { parseShellRoute } from "@/platform/identity/route"

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

export function pathnameTargetsSession(pathname: string, sessionId: string) {
  const route = parseShellRoute(pathname)
  if (route.kind === "session" || route.kind === "workspace-session" || route.kind === "legacy-directory") {
    return route.sessionId === sessionId
  }
  return false
}
