import { onMount, type Component } from "solid-js"
import { useLocation } from "@solidjs/router"
import { parseShellRoute } from "@/platform/identity/route"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import { remoteAccessClientId, shouldRecordSecondDeviceOpen } from "./remote-access-state"

/**
 * Records that a workspace was opened from a SECOND signed-in client.
 *
 * Runs on the device that followed the link — a phone, another browser — never
 * on the machine that published itself. That asymmetry is why the operation is
 * optional on the port and absent on the desktop: the desktop is the first
 * device by construction.
 */
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
    void machineRemoteAccess()?.markSecondDeviceOpen?.({
      workspaceId: route.workspaceId,
      sourceClientId,
      currentClientId: remoteAccessClientId(),
    })
  })

  return null
}
