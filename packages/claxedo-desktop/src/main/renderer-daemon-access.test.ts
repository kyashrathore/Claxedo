import { describe, expect, test } from "bun:test"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER } from "./daemon-request"
import {
  DEFAULT_SESSION_REQUEST_URLS,
  daemonReaderOrigin,
  daemonRequestHeaders,
  daemonResponseListener,
  grantMainRendererDaemonAccess,
  withAllowedOrigin,
  type BeforeSendHeadersDetails,
  type DaemonResponseDetails,
  type DaemonResponseHeaders,
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
  id: 1,
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
  const credentials: BeforeSendHeadersDetails = {
    id: 7,
    url: `${DAEMON}/api/claxedo/credentials`,
    requestHeaders: { Origin: DEV_ORIGIN },
    webContentsId: MAIN_WEBCONTENTS,
    frame: { url: DEV_DOCUMENT, parent: null },
  }
  const readerOf = (details: Partial<BeforeSendHeadersDetails>, against = devPolicy) =>
    daemonReaderOrigin({ ...credentials, ...details }, against)

  test("is its document's own origin when that is exactly the origin the request sent", () => {
    expect(readerOf({})).toBe(DEV_ORIGIN)
    expect(readerOf({ requestHeaders: { origin: DEV_ORIGIN } })).toBe(DEV_ORIGIN)
  })

  test("a foreign or missing request origin is no reader", () => {
    expect(readerOf({ requestHeaders: { Origin: "http://127.0.0.1:5174" } })).toBeUndefined()
    expect(readerOf({ requestHeaders: { Origin: "https://evil.example" } })).toBeUndefined()
    expect(readerOf({ requestHeaders: {} })).toBeUndefined()
  })

  test("a subframe, another webContents, another document or an unreadable frame is no reader", () => {
    expect(readerOf({ frame: { url: DEV_DOCUMENT, parent: { url: DEV_DOCUMENT } } })).toBeUndefined()
    expect(readerOf({ webContentsId: 42 })).toBeUndefined()
    expect(readerOf({ webContentsId: undefined })).toBeUndefined()
    expect(readerOf({ frame: { url: "http://127.0.0.1:5174/index.local.html", parent: null }, requestHeaders: { Origin: "http://127.0.0.1:5174" } })).toBeUndefined()
    expect(readerOf({ frame: null })).toBeUndefined()
  })

  test("a request to anywhere but the daemon is no reader", () => {
    expect(readerOf({ url: `${DEV_ORIGIN}/assets/index.js` })).toBeUndefined()
    expect(readerOf({ url: "https://api.example/credentials" })).toBeUndefined()
  })

  test.each(["null", "file://"])("the packaged document, sending %s, is no reader", (opaque) => {
    expect(readerOf({ frame: { url: RENDERER_DOCUMENT, parent: null }, requestHeaders: { Origin: opaque } }, policy)).toBeUndefined()
  })

  test("the answer echoes the reader's origin in place of any the daemon sent, and grants nothing else", () => {
    expect(withAllowedOrigin({ "content-type": ["application/json"], "access-control-allow-origin": [DAEMON] }, DEV_ORIGIN)).toEqual({
      "content-type": ["application/json"],
      "Access-Control-Allow-Origin": [DEV_ORIGIN],
    })
  })

  test("the grant answers exactly the responses to requests it judged readers, once each", () => {
    let listener: ((details: BeforeSendHeadersDetails, callback: (response: { requestHeaders: Record<string, string> }) => void) => void) | undefined
    const respond = grantMainRendererDaemonAccess({ policy: devPolicy, onBeforeSendHeaders: (_filter, next) => { listener = next } })
    const send = (details: Partial<BeforeSendHeadersDetails>) => {
      let sent: Record<string, string> | undefined
      listener?.({ ...credentials, ...details }, (response) => { sent = response.requestHeaders })
      return sent
    }
    const response = (id: number) => respond({ id, url: credentials.url, responseHeaders: { vary: ["Origin"] } })

    expect(send({})).toEqual({ Origin: DEV_ORIGIN, [CLAXEDO_DAEMON_CAPABILITY_HEADER]: "installation-secret" })
    expect(response(7)).toEqual({ vary: ["Origin"], "Access-Control-Allow-Origin": [DEV_ORIGIN] })
    expect(response(7)).toBeUndefined()

    send({ id: 8, requestHeaders: { Origin: "https://evil.example" } })
    expect(response(8)).toBeUndefined()

    send({ id: 9 })
    send({ id: 9, url: "https://elsewhere.example/landing", requestHeaders: {} })
    expect(response(9)).toBeUndefined()
  })

  test("the session's one response listener answers the daemon's responses and hands every other to the document policy", () => {
    const passed: number[] = []
    let daemonResponses: DaemonResponseHeaders | undefined
    const listener = daemonResponseListener<DaemonResponseDetails>({
      daemonResponses: () => daemonResponses,
      otherwise: (details, callback) => {
        passed.push(details.id)
        callback({})
      },
    })
    const answer = (details: DaemonResponseDetails) => {
      let sent: { responseHeaders?: Record<string, string[]> } | undefined
      listener(details, (response) => { sent = response })
      return sent
    }

    expect(answer({ id: 1, url: credentials.url })).toEqual({})
    daemonResponses = (details) => (details.id === 2 ? { "Access-Control-Allow-Origin": [DEV_ORIGIN] } : undefined)
    expect(answer({ id: 2, url: credentials.url })).toEqual({ responseHeaders: { "Access-Control-Allow-Origin": [DEV_ORIGIN] } })
    expect(answer({ id: 3, url: DEV_DOCUMENT })).toEqual({})
    expect(passed).toEqual([1, 3])
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
