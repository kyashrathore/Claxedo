import { createEffect, type Component } from "solid-js"
import { useLocation, useSearchParams } from "@solidjs/router"
import { parseShellRoute } from "@/platform/identity/route"
import { machineRemoteAccess } from "@/platform/remote-access/machine-remote-access"
import {
  remoteAccessClientId,
  shouldRecordSecondDeviceOpen,
  SECOND_DEVICE_PARAM,
  SECOND_DEVICE_SOURCE_PARAM,
  SECOND_DEVICE_STASH_KEY,
} from "./remote-access-state"

type SearchParamWriter = (values: Record<string, string | undefined>, options: { replace: true }) => void

/**
 * Records that a workspace was opened from a SECOND signed-in client.
 *
 * Runs on the device that followed the link — a phone, another browser — never
 * on the machine that published itself. That asymmetry is why the operation is
 * optional on the port and absent on the desktop: the desktop is the first
 * device by construction.
 *
 * ## Why this is two legs and not one call
 *
 * Sharing is machine level, so the QR points at the app ROOT: enabling remote
 * access publishes every local workspace, and no single one of them is "the"
 * destination. The marker therefore ARRIVES on a URL that names no workspace,
 * while `markSecondDeviceOpen` needs one. The workspace it proves is whichever
 * one this device opens first, which is a later moment than the landing.
 *
 *   1. **Capture.** Marker params on any route are stashed in `sessionStorage`
 *      and stripped from the visible URL. Stripping is not cosmetic: a marker
 *      left in the address bar would re-arm itself on every reload, including
 *      reloads after it had already been spent.
 *   2. **Attribute.** On the first route that parses to a workspace, the stash
 *      is cleared and the open is recorded. Clearing first makes the record
 *      once-only even if the port call is slow or fails.
 *
 * A link that already names a workspace still works: both legs run in the same
 * pass, so it records immediately.
 *
 * `sessionStorage` is per-tab and dies with it, which is the right lifetime —
 * this proves one arrival, not a standing property of the browser. Every
 * access is guarded because a packaged renderer can be served from a `file://`
 * origin, where storage access throws rather than returning null.
 */
export const RemoteAccessMarkerRecorder: Component = () => {
  const location = useLocation()
  const [, setSearchParams] = useSearchParams()

  // Reactive, not `onMount`: the two legs are usually two different routes, and
  // the second one happens while this component stays mounted.
  createEffect(() => {
    const pathname = location.pathname
    const search = location.search
    captureMarker(pathname, search, setSearchParams as SearchParamWriter)
    attributeMarker(pathname)
  })

  return null
}

function captureMarker(pathname: string, search: string, writeParams: SearchParamWriter) {
  if (typeof window === "undefined") return
  const url = new URL(`${pathname}${search}`, window.location.origin)
  const sourceClientId = url.searchParams.get(SECOND_DEVICE_SOURCE_PARAM)
  if (!sourceClientId || !shouldRecordSecondDeviceOpen({
    url,
    currentClientId: remoteAccessClientId(),
    signedIn: true,
  })) return
  stashMarker(sourceClientId)
  // Through the router rather than `history.replaceState`, so the router's own
  // location does not go stale against the address bar.
  writeParams({ [SECOND_DEVICE_PARAM]: undefined, [SECOND_DEVICE_SOURCE_PARAM]: undefined }, { replace: true })
}

function attributeMarker(pathname: string) {
  const sourceClientId = readMarker()
  if (!sourceClientId) return
  const route = parseShellRoute(pathname)
  if (!("workspaceId" in route) || !route.workspaceId) return
  // Cleared BEFORE the call: the marker is spent by being attributed, and a
  // rejected or slow port call must not leave it armed for the next route.
  clearMarker()
  void machineRemoteAccess()?.markSecondDeviceOpen?.({
    workspaceId: route.workspaceId,
    sourceClientId,
    currentClientId: remoteAccessClientId(),
  })
}

function stashMarker(sourceClientId: string) {
  try {
    window.sessionStorage.setItem(SECOND_DEVICE_STASH_KEY, sourceClientId)
  } catch {
    // No session storage (file:// origin, storage disabled). The funnel signal
    // is lost for this arrival; nothing else depends on it.
  }
}

function readMarker() {
  try {
    return window.sessionStorage.getItem(SECOND_DEVICE_STASH_KEY)?.trim() || undefined
  } catch {
    return undefined
  }
}

function clearMarker() {
  try {
    window.sessionStorage.removeItem(SECOND_DEVICE_STASH_KEY)
  } catch {
    // Already unreachable if the write failed; nothing to undo.
  }
}
