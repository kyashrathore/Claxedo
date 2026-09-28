import { describe, expect, test } from "bun:test"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER } from "./daemon-request"
import {
  DEFAULT_SESSION_REQUEST_URLS,
  daemonRequestHeaders,
  daemonResponseHeaders,
  daemonResponseListener,
  grantMainRendererDaemonAccess,
  type BeforeSendHeadersDetails,
  type DaemonResponseDetails,
} from "./renderer-daemon-access"

/**
 * The policy table. That the shapes below are the ones Electron really hands a
 * listener — `frame.parent`, `webContentsId`, and which `Origin` a `file://`
 * document sends — is proved separately against the installed Electron in
 * `scripts/renderer-daemon-access.electron.test.ts`; this file is the fast,
 * exhaustive half and cannot establish it.
 */

const DAEMON = "http://127.0.0.1:2593"
const RENDERER_DOCUMENT = "file:///Applications/Claxedo.app/Contents/renderer/index.local.html"
const MAIN_WEBCONTENTS = 1

const policy = {
  daemonOrigin: DAEMON,
  capability: "installation-secret",
  isBridgeCarryingWebContents: (id: number) => id === MAIN_WEBCONTENTS,
  isTrustedDocumentUrl: (url: string) => url === RENDERER_DOCUMENT,
}

const mainFrame: BeforeSendHeadersDetails = {
  url: `${DAEMON}/api/claxedo/session`,
  requestHeaders: {},
  webContentsId: MAIN_WEBCONTENTS,
  frame: { url: RENDERER_DOCUMENT, parent: null },
}

const headersFor = (details: Partial<BeforeSendHeadersDetails>) =>
  daemonRequestHeaders({ ...mainFrame, ...details }, policy)

const capabilityIn = (details: Partial<BeforeSendHeadersDetails>) =>
  headersFor(details)[CLAXEDO_DAEMON_CAPABILITY_HEADER]

describe("the trusted main renderer", () => {
  test("is given the capability on HTTP and on a WebSocket handshake alike", () => {
    expect(capabilityIn({})).toBe("installation-secret")
    // A socket upgrade reaches this hook under ws:, on the same listener.
    expect(capabilityIn({ url: "ws://127.0.0.1:2593/api/wr/pty/p1/connect" })).toBe("installation-secret")
  })

  // Both values a document with an opaque origin has been observed to send.
  test.each(["file://", "null"])("has its %s origin repaired for the daemon's loopback gate", (opaque) => {
    const headers = headersFor({
      url: "ws://127.0.0.1:2593/api/cp/events",
      requestHeaders: { Origin: opaque, Upgrade: "websocket" },
    })

    expect(headers).toEqual({
      Origin: DAEMON,
      Upgrade: "websocket",
      [CLAXEDO_DAEMON_CAPABILITY_HEADER]: "installation-secret",
    })
  })

  test("never has a real origin laundered into the daemon's", () => {
    expect(headersFor({ requestHeaders: { Origin: "https://evil.example" } }).Origin).toBe("https://evil.example")
  })
})

describe("what the trusted development renderer may read", () => {
  const DEV_ORIGIN = "http://127.0.0.1:5173"
  const DEV_DOCUMENT = `${DEV_ORIGIN}/index.local.html`
  const devPolicy = { ...policy, isTrustedDocumentUrl: (url: string) => new URL(url).origin === DEV_ORIGIN }
  const credentials: DaemonResponseDetails = {
    url: `${DAEMON}/api/claxedo/credentials`,
    webContentsId: MAIN_WEBCONTENTS,
    frame: { url: DEV_DOCUMENT, parent: null },
    responseHeaders: { "content-type": ["application/json"] },
  }
  const responseFor = (details: Partial<DaemonResponseDetails>, against = devPolicy) =>
    daemonResponseHeaders({ ...credentials, ...details }, against)

  test("a daemon response names the document's own origin, replacing any the daemon sent", () => {
    expect(responseFor({})).toEqual({ "content-type": ["application/json"], "Access-Control-Allow-Origin": [DEV_ORIGIN] })
    expect(responseFor({ responseHeaders: { "access-control-allow-origin": [DAEMON] } })).toEqual({ "Access-Control-Allow-Origin": [DEV_ORIGIN] })
  })

  test("its own request keeps the origin it sent, which Chromium checks the answer against", () => {
    const headers = daemonRequestHeaders({ ...mainFrame, frame: credentials.frame, requestHeaders: { Origin: DEV_ORIGIN } }, devPolicy)
    expect(headers.Origin).toBe(DEV_ORIGIN)
  })

  test("a subframe, an unregistered webContents, another document or an unreadable frame reads nothing", () => {
    expect(responseFor({ frame: { url: DEV_DOCUMENT, parent: { url: DEV_DOCUMENT } } })).toBeUndefined()
    expect(responseFor({ webContentsId: 42 })).toBeUndefined()
    expect(responseFor({ webContentsId: undefined })).toBeUndefined()
    expect(responseFor({ frame: { url: "http://127.0.0.1:5174/index.local.html", parent: null } })).toBeUndefined()
    expect(responseFor({ frame: null })).toBeUndefined()
  })

  test("a response from anywhere but the daemon is left alone", () => {
    expect(responseFor({ url: `${DEV_ORIGIN}/assets/index.js` })).toBeUndefined()
    expect(responseFor({ url: "https://api.example/credentials" })).toBeUndefined()
  })

  test("a packaged document, which Chromium does not hold to the check, gets nothing", () => {
    expect(responseFor({ frame: { url: RENDERER_DOCUMENT, parent: null } }, policy)).toBeUndefined()
  })

  test("the session's one listener answers the daemon's responses and hands every other to the document policy", () => {
    const passed: string[] = []
    let current: typeof devPolicy | undefined
    const listener = daemonResponseListener<DaemonResponseDetails>({
      policy: () => current,
      otherwise: (details, callback) => {
        passed.push(details.url)
        callback({})
      },
    })
    const answer = (details: DaemonResponseDetails) => {
      let sent: { responseHeaders?: Record<string, string[]> } | undefined
      listener(details, (response) => { sent = response })
      return sent
    }

    expect(answer(credentials)).toEqual({})
    current = devPolicy
    expect(answer(credentials)?.responseHeaders?.["Access-Control-Allow-Origin"]).toEqual([DEV_ORIGIN])
    expect(answer({ ...credentials, url: DEV_DOCUMENT })).toEqual({})
    expect(passed).toEqual([credentials.url, DEV_DOCUMENT])
  })
})

describe("callers that are not the main renderer", () => {
  const subframe = { frame: { url: RENDERER_DOCUMENT, parent: { url: RENDERER_DOCUMENT } } }

  test("a subframe of the very same window is refused", () => {
    expect(capabilityIn(subframe)).toBeUndefined()
  })

  test("a guest is refused, being a webContents this process never registered", () => {
    expect(capabilityIn({ webContentsId: 42 })).toBeUndefined()
  })

  test("the main window is refused once it is showing some other document", () => {
    expect(capabilityIn({ frame: { url: "https://evil.example/page", parent: null } })).toBeUndefined()
  })

  test("a request whose frame or webContents cannot be read is refused", () => {
    expect(capabilityIn({ frame: null })).toBeUndefined()
    expect(capabilityIn({ webContentsId: undefined })).toBeUndefined()
  })

  // The repair is trust too: an opaque-origin iframe would otherwise have its
  // origin turned into the daemon's own.
  test("a subframe's opaque origin is left alone rather than repaired", () => {
    expect(headersFor({ ...subframe, requestHeaders: { Origin: "file://" } }).Origin).toBe("file://")
  })
})

describe("where the capability may travel", () => {
  test("a page's own capability header is stripped, whatever its casing", () => {
    expect(headersFor({
      frame: { url: RENDERER_DOCUMENT, parent: { url: RENDERER_DOCUMENT } },
      requestHeaders: { "X-Claxedo-Daemon-Capability": "guessed", accept: "application/json" },
    })).toEqual({ accept: "application/json" })
  })

  // A redirect is where a daemon-scoped filter cannot reach: the hop is a new
  // request to somewhere else, carrying whatever the last one had.
  test("it is stripped, never added, on a request to any other destination", () => {
    expect(headersFor({
      url: "https://analytics.example/collect",
      requestHeaders: { [CLAXEDO_DAEMON_CAPABILITY_HEADER]: "installation-secret" },
    })).toEqual({})
  })

  test("the listener therefore watches every scheme it could travel on", () => {
    let filter: { urls: string[] } | undefined
    grantMainRendererDaemonAccess({ policy, onBeforeSendHeaders: (next) => { filter = next } })

    expect(filter?.urls).toEqual(["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"])
    expect(DEFAULT_SESSION_REQUEST_URLS).toEqual(filter?.urls ?? [])
  })

  // Registering the listener and applying the policy are separate mistakes to
  // make, so drive the registered callback rather than only the policy.
  test("the registered callback is the policy, not a second one", () => {
    let listener: Parameters<Parameters<typeof grantMainRendererDaemonAccess>[0]["onBeforeSendHeaders"]>[1] | undefined
    grantMainRendererDaemonAccess({ policy, onBeforeSendHeaders: (_filter, next) => { listener = next } })

    let sent: Record<string, string> | undefined
    listener?.(
      { ...mainFrame, url: "ws://127.0.0.1:2593/api/wr/pty/p1/connect", requestHeaders: { Origin: "file://" } },
      (response) => { sent = response.requestHeaders },
    )

    expect(sent).toEqual({ Origin: DAEMON, [CLAXEDO_DAEMON_CAPABILITY_HEADER]: "installation-secret" })
  })
})
