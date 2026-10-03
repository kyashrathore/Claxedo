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
 * WHAT IT MAY READ. A development renderer is an http document on its own
 * port, so every daemon response is a cross-origin read, and Chromium checks
 * `Access-Control-Allow-Origin` against the document's real origin whatever
 * `Origin` header went out, so rewriting that header cannot help. The daemon
 * answers its credential routes to no other origin, the development renderer's
 * included, so main names the document's origin on the daemon's responses to
 * this same trusted top frame, only for a request whose `Origin` is exactly
 * that origin, and to no one else. Preflights pass through both listeners
 * like any other request. A packaged `file://` document's daemon reads
 * already succeed, and it gets nothing.
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

export const HTTP_REQUEST_URLS = ["http://*/*", "https://*/*"]

/** Every scheme a stamped capability could travel on, so none escapes the strip. */
export const DEFAULT_SESSION_REQUEST_URLS = [...HTTP_REQUEST_URLS, "ws://*/*", "wss://*/*"]

/** A WebSocket upgrade reaches `webRequest` under its own scheme, on the daemon's listener. */
const SOCKET_SCHEME: Record<string, string> = { "ws:": "http:", "wss:": "https:" }

type RendererRequestDetails = {
  id: number
  url: string
  webContentsId?: number
  frame?: { url: string; parent: unknown } | null
}

/** What a live Electron `onBeforeSendHeaders` listener is handed, as this policy reads it. */
export type BeforeSendHeadersDetails = RendererRequestDetails & { requestHeaders: Record<string, string> }

/** What a live Electron `onHeadersReceived` listener is handed, as this policy reads it. */
export type DaemonResponseDetails = RendererRequestDetails & { responseHeaders?: Record<string, string[]> }

export type RendererDaemonPolicy = {
  daemonOrigin: string
  capability: string | undefined
  isBridgeCarryingWebContents: (webContentsId: number) => boolean
  isTrustedDocumentUrl: (url: string) => boolean
}

function trustedRendererDocument(details: RendererRequestDetails, policy: RendererDaemonPolicy): string | undefined {
  const frame = details.frame
  // `parent == null` rather than `=== null`: "no parent" is the claim, and the
  // electron test pins which of the two the runtime actually reports.
  if (!frame || frame.parent != null) return undefined
  if (details.webContentsId === undefined || !policy.isBridgeCarryingWebContents(details.webContentsId)) return undefined
  return policy.isTrustedDocumentUrl(frame.url) ? frame.url : undefined
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

/** Cleanup installation is a main-owned credential write, never a renderer request. */
function mainOnlyDaemonRequest(url: string, daemonOrigin: string): boolean {
  if (!isDaemonDestination(url, daemonOrigin)) return false
  try {
    let path = new URL(url).pathname
    // Refuse encoded aliases too: routers can decode separators and paths in
    // more than one layer. Each changing pass consumes encoding from the URL.
    while (path.includes("%")) {
      const decoded = decodeURIComponent(path)
      if (decoded === path) break
      path = decoded
    }
    path = new URL(path.replace(/\\/g, "/").replace(/\/+/g, "/"), daemonOrigin).pathname.replace(/\/+$/, "")
    const route = "/api/claxedo/daemon/session-cleanup"
    return path === route || path.startsWith(`${route}/`)
  } catch {
    // An undecodable path cannot be established as renderer-accessible.
    return true
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
  if (mainOnlyDaemonRequest(details.url, policy.daemonOrigin)) return headers
  if (!trustedRendererDocument(details, policy)) return headers

  const daemonOrigin = new URL(policy.daemonOrigin).origin
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "origin" && OPAQUE_ORIGINS.has(headers[name])) headers[name] = daemonOrigin
  }
  if (policy.capability) headers[CLAXEDO_DAEMON_CAPABILITY_HEADER] = policy.capability
  return headers
}

/**
 * The origin a daemon response may name for this request: the trusted top
 * frame's own, and only when that is exactly the `Origin` it sent.
 */
export function daemonReaderOrigin(details: BeforeSendHeadersDetails, policy: RendererDaemonPolicy): string | undefined {
  if (!isDaemonDestination(details.url, policy.daemonOrigin)) return undefined
  if (mainOnlyDaemonRequest(details.url, policy.daemonOrigin)) return undefined
  const document = trustedRendererDocument(details, policy)
  if (!document) return undefined
  const documentOrigin = new URL(document).origin
  if (OPAQUE_ORIGINS.has(documentOrigin)) return undefined
  const sent = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === "origin")?.[1]
  return sent === documentOrigin ? documentOrigin : undefined
}

export function withAllowedOrigin(headers: Record<string, string[]> | undefined, origin: string): Record<string, string[]> {
  const kept = Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "access-control-allow-origin")
  return { ...Object.fromEntries(kept), "Access-Control-Allow-Origin": [origin] }
}

export type DaemonResponseHeaders = (details: DaemonResponseDetails) => Record<string, string[]> | undefined

/**
 * Electron wiring for the policy above, kept as a callback seam so the policy
 * stays loadable outside an Electron process — the split `navigation-guard.ts`
 * and `ipc-caller-guard.ts` use. `onBeforeSendHeaders` holds one listener per
 * session, so the strip and the stamp have to be that one listener.
 *
 * A response listener is not handed the request's headers, so the origin each
 * request was judged by is kept under Electron's request id until its response
 * arrives. A hop to anywhere else, a redirect included, is judged again and
 * forgets it.
 */
export function grantMainRendererDaemonAccess(input: {
  policy: RendererDaemonPolicy
  onBeforeSendHeaders: (
    filter: { urls: string[] },
    listener: (
      details: BeforeSendHeadersDetails,
      callback: (response: { requestHeaders: Record<string, string>; cancel?: boolean }) => void,
    ) => void,
  ) => void
}): DaemonResponseHeaders {
  const readers = new Map<number, string>()
  input.onBeforeSendHeaders({ urls: DEFAULT_SESSION_REQUEST_URLS }, (details, callback) => {
    if (mainOnlyDaemonRequest(details.url, input.policy.daemonOrigin)) {
      readers.delete(details.id)
      callback({ cancel: true, requestHeaders: daemonRequestHeaders(details, input.policy) })
      return
    }
    const reader = daemonReaderOrigin(details, input.policy)
    if (reader) readers.set(details.id, reader)
    else readers.delete(details.id)
    callback({ requestHeaders: daemonRequestHeaders(details, input.policy) })
  })
  return (details) => {
    const reader = readers.get(details.id)
    if (!reader) return undefined
    readers.delete(details.id)
    return withAllowedOrigin(details.responseHeaders, reader)
  }
}

type HeadersReceivedListener<Details> = (
  details: Details,
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
) => void

/**
 * `onHeadersReceived` also holds one listener per session, and the renderer
 * document's Content-Security-Policy is stamped there before any daemon is
 * known, so the daemon's responses join that listener rather than replace it.
 */
export function daemonResponseListener<Details extends DaemonResponseDetails>(input: {
  daemonResponses: () => DaemonResponseHeaders | undefined
  otherwise: HeadersReceivedListener<Details>
}): HeadersReceivedListener<Details> {
  return (details, callback) => {
    const headers = input.daemonResponses()?.(details)
    if (headers) callback({ responseHeaders: headers })
    else input.otherwise(details, callback)
  }
}
