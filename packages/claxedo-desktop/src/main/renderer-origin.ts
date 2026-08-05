/**
 * Present a loopback origin for the main renderer's calls to its own server.
 *
 * The packaged renderer is loaded with `win.loadFile(...)`, so it is a `file://`
 * document. Chromium omits `Origin` on a plain cross-origin `fetch` from such a
 * page — which is why the HTTP API works — but a **WebSocket handshake always
 * carries one**, and from `file://` that value is the literal `file://`.
 *
 * claxedo-server's unsigned-local gate (`isLoopbackLocalRequest`) parses the
 * origin and requires a loopback *hostname*; `new URL("file://").hostname` is
 * `""`, so every WebSocket upgrade was answered `403 unsigned_local_loopback_
 * required`. That killed the terminal (endless `[Reconnecting... attempt n/6]`)
 * and every other socket-backed surface, while leaving HTTP working — which is
 * what made it look like a terminal-specific bug.
 *
 * The rewrite happens here rather than by widening the server gate on purpose.
 * Teaching claxedo-server to accept `file://` would also admit any local HTML
 * file the user happens to open in a normal browser: such a page can open
 * `ws://127.0.0.1:3001` and drive a real shell. The trust boundary belongs on
 * this side, where we know the request came from our own renderer:
 *
 *  - only `session.defaultSession` is patched, so the untrusted browser-tab
 *    partition (`persist:agent-browser`) is deliberately excluded;
 *  - only requests to the app's own server origin are matched;
 *  - only the exact value `file://` is replaced, so a real origin from an
 *    iframe or webview is never laundered into a trusted one.
 */
export function FILE_ORIGIN() {
  return "file://"
}

export function rewriteFileOrigin(input: {
  requestHeaders: Record<string, string>
  serverOrigin: string
}): Record<string, string> {
  const headers = { ...input.requestHeaders }
  // Header names are case-insensitive and Chromium's casing is not contractual.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== "origin") continue
    if (headers[name] !== FILE_ORIGIN()) continue
    headers[name] = input.serverOrigin
  }
  return headers
}

export function serverOriginFilters(serverUrl: string) {
  const url = new URL(serverUrl)
  const authority = url.host
  return {
    origin: url.origin,
    // WebSocket upgrades are surfaced to webRequest under the ws:/wss: scheme,
    // so the http(s) pattern alone would miss precisely the requests that broke.
    urls: [
      `${url.protocol}//${authority}/*`,
      `${url.protocol === "https:" ? "wss:" : "ws:"}//${authority}/*`,
    ],
  }
}

/**
 * Electron wiring for the policy above. Kept as a callback-shaped seam (rather
 * than importing `electron` here) so the policy stays unit-testable: importing
 * `electron` at module scope makes this file unloadable outside a real Electron
 * process, which is the same split `navigation-guard.ts` / `windows.ts` uses.
 */
export function trustMainRendererOrigin(input: {
  serverUrl: string
  onBeforeSendHeaders: (
    filter: { urls: string[] },
    listener: (
      details: { requestHeaders: Record<string, string> },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ) => void
}) {
  const filters = serverOriginFilters(input.serverUrl)
  input.onBeforeSendHeaders({ urls: filters.urls }, (details, callback) => {
    callback({
      requestHeaders: rewriteFileOrigin({
        requestHeaders: details.requestHeaders,
        serverOrigin: filters.origin,
      }),
    })
  })
}
