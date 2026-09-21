/**
 * What the trusted main renderer may present to its own daemon.
 *
 * The daemon admits privileged calls only from the application that owns it
 * (`claxedo-local-server`'s `daemon-admission.ts`). The renderer must therefore
 * present the daemon token and must never HOLD it: a token in `serverReady`, an
 * IPC reply or an injected global is readable by any script that reaches the
 * page. So main stamps it onto the outgoing request, where page script cannot
 * read it back, on the same hook that covers the WebSocket handshake — the only
 * point a socket can carry a header at all.
 *
 * The same hook repairs the renderer's origin. A packaged renderer is a
 * `file://` document, whose origin is opaque; Chromium omits `Origin` on a
 * plain cross-origin `fetch` from such a page but always sends one on a
 * WebSocket handshake. The daemon's loopback gate parses that value and needs a
 * loopback hostname, so every upgrade was answered `403`, killing the terminal
 * while HTTP kept working. The repair belongs here, not in a wider daemon gate
 * that would also admit any local HTML file opened in an ordinary browser.
 *
 * WHO COUNTS AS THE RENDERER. Not "a `file://` document" and not "the default
 * session": a subframe, a guest and a window that navigated away all share
 * those properties. The caller must be a webContents this process registered as
 * bridge-carrying (`ipc-caller-guard.ts`, the same registry the IPC boundary
 * trusts), it must be that webContents' top frame, and that frame's current
 * document must be one `renderer-url-trust.ts` trusts. Missing frame or
 * webContents information fails all three.
 *
 * WHAT LEAVES. The listener covers every http(s)/ws(s) request of the session,
 * not only the daemon's, because its first act is to strip any capability
 * header already present — covering a page that set one itself and, the case a
 * daemon-scoped filter cannot reach, a redirect carrying one onward.
 */

import { CLAXEDO_DAEMON_CAPABILITY_HEADER } from "./daemon-request"

/**
 * How a document with an opaque origin names itself on the wire. Both are
 * accepted because Chromium has sent each across versions;
 * `renderer-daemon-access.electron.test.ts` records which the installed one
 * does. Repairing either is safe only because it happens after the caller is
 * established as the trusted top frame — a subframe's opaque origin is never
 * laundered into the daemon's.
 */
const OPAQUE_ORIGINS = new Set(["file://", "null"])

/** Every scheme a stamped capability could travel on, so none escapes the strip. */
export const DEFAULT_SESSION_REQUEST_URLS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]

/** A WebSocket upgrade reaches `webRequest` under its own scheme, on the daemon's listener. */
const SOCKET_SCHEME: Record<string, string> = { "ws:": "http:", "wss:": "https:" }

/** What a live Electron `onBeforeSendHeaders` listener is handed, as this policy reads it. */
export type BeforeSendHeadersDetails = {
  url: string
  requestHeaders: Record<string, string>
  webContentsId?: number
  frame?: { url: string; parent: unknown } | null
}

export type RendererDaemonPolicy = {
  daemonOrigin: string
  capability: string | undefined
  isBridgeCarryingWebContents: (webContentsId: number) => boolean
  isTrustedDocumentUrl: (url: string) => boolean
}

function isTrustedRenderer(details: BeforeSendHeadersDetails, policy: RendererDaemonPolicy): boolean {
  const frame = details.frame
  // `parent == null` rather than `=== null`: "no parent" is the claim, and the
  // electron test pins which of the two the runtime actually reports.
  if (!frame || frame.parent != null) return false
  if (details.webContentsId === undefined || !policy.isBridgeCarryingWebContents(details.webContentsId)) return false
  return policy.isTrustedDocumentUrl(frame.url)
}

function isDaemonDestination(url: string, daemonOrigin: string): boolean {
  try {
    const target = new URL(url)
    target.protocol = SOCKET_SCHEME[target.protocol] ?? target.protocol
    return target.origin === new URL(daemonOrigin).origin
  } catch {
    return false
  }
}

export function daemonRequestHeaders(
  details: BeforeSendHeadersDetails,
  policy: RendererDaemonPolicy,
): Record<string, string> {
  const headers: Record<string, string> = {}
  // Header names are case-insensitive and Chromium's casing is not contractual.
  for (const [name, value] of Object.entries(details.requestHeaders)) {
    if (name.toLowerCase() !== CLAXEDO_DAEMON_CAPABILITY_HEADER) headers[name] = value
  }
  if (!isDaemonDestination(details.url, policy.daemonOrigin)) return headers
  if (!isTrustedRenderer(details, policy)) return headers

  const daemonOrigin = new URL(policy.daemonOrigin).origin
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "origin" && OPAQUE_ORIGINS.has(headers[name])) headers[name] = daemonOrigin
  }
  if (policy.capability) headers[CLAXEDO_DAEMON_CAPABILITY_HEADER] = policy.capability
  return headers
}

/**
 * Electron wiring for the policy above, kept as a callback seam so the policy
 * stays loadable outside an Electron process — the split `navigation-guard.ts`
 * and `ipc-caller-guard.ts` use. `onBeforeSendHeaders` holds one listener per
 * session, so the strip and the stamp have to be that one listener.
 */
export function grantMainRendererDaemonAccess(input: {
  policy: RendererDaemonPolicy
  onBeforeSendHeaders: (
    filter: { urls: string[] },
    listener: (
      details: BeforeSendHeadersDetails,
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ) => void
}) {
  input.onBeforeSendHeaders({ urls: DEFAULT_SESSION_REQUEST_URLS }, (details, callback) => {
    callback({ requestHeaders: daemonRequestHeaders(details, input.policy) })
  })
}
