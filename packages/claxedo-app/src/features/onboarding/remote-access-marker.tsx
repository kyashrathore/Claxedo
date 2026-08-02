import { onMount, type Component } from "solid-js"
import { useLocation } from "@solidjs/router"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { parseShellRoute } from "@/platform/identity/route"
import { createRemoteAccessClient } from "./remote-access-api"
import { remoteAccessClientId, shouldRecordSecondDeviceOpen } from "./remote-access-state"

export const RemoteAccessMarkerRecorder: Component = () => {
  const location = useLocation()

  onMount(() => {
    const url = new URL(`${location.pathname}${location.search}`, window.location.origin)
    const sourceClientId = url.searchParams.get("claxedo_source_client")
    const route = parseShellRoute(location.pathname)
    if (!sourceClientId || !("workspaceId" in route) || !route.workspaceId || !shouldRecordSecondDeviceOpen({
      url,
      currentClientId: remoteAccessClientId(),
      signedIn: true,
    })) return
    void createRemoteAccessClient({
      request: (path, init) => authFetch(new URL(path, getClaxedoServerUrl()), init),
    }).markSecondDeviceOpen(route.workspaceId, sourceClientId, remoteAccessClientId())
  })

  return null
}
