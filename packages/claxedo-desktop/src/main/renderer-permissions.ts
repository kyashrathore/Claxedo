/**
 * What the app document may ask the browser for.
 *
 * Electron grants every permission request a session has no handler for, so
 * without this the app window's session would answer geolocation, camera,
 * screen capture, MIDI and the rest with yes. The set below is what the
 * renderer reaches today: session notifications (`Notification.requestPermission`
 * and `new Notification`), the copy buttons (`navigator.clipboard.writeText`),
 * and the terminal's OSC 52 clipboard addon, which answers a query with
 * `navigator.clipboard.readText`. Everything else is denied, and even these
 * are denied to any document other than the app's own top frame — a subframe
 * shares its parent's webContents and would otherwise inherit the grant.
 *
 * The agent-browser `<webview>` partition is a separate session with its own
 * default-deny handlers in `browser/partition.ts`; this never applies there.
 *
 * Electron imports are type-only so the policy is directly testable.
 */
import type { Session } from "electron"

export const RENDERER_PERMISSIONS: ReadonlySet<string> = new Set([
  "notifications",
  "clipboard-sanitized-write",
  "clipboard-read",
])

export type PermissionRequester = {
  permission: string
  /** Absent on a cross-origin subframe check, which is not the app document. */
  requestingUrl: string | undefined
  isMainFrame: boolean
}

export function rendererPermissionAllowed(
  input: PermissionRequester,
  isTrustedDocument: (url: string) => boolean,
): boolean {
  if (!RENDERER_PERMISSIONS.has(input.permission)) return false
  if (!input.isMainFrame) return false
  if (input.requestingUrl === undefined) return false
  return isTrustedDocument(input.requestingUrl)
}

type PermissionSession = Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler">

export function installRendererPermissionPolicy(
  session: PermissionSession,
  isTrustedDocument: (url: string) => boolean,
) {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(
      rendererPermissionAllowed(
        { permission, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame },
        isTrustedDocument,
      ),
    )
  })
  session.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) =>
    rendererPermissionAllowed(
      { permission, requestingUrl: details.requestingUrl, isMainFrame: details.isMainFrame },
      isTrustedDocument,
    ),
  )
}
