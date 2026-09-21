import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// Electron main cannot be imported in a unit process because importing it boots
// the application. Pin the ordering at the real entry instead: renderer load
// may overlap the server, but serverReady must still be resolved only after the
// daemon-access hook and verified health boundary are installed.
const entry = readFileSync(path.join(import.meta.dir, "index.ts"), "utf8")
const initialize = entry.slice(entry.indexOf("async function initialize()"), entry.indexOf("function showMainWindow"))
const serverStart = entry.slice(
  entry.indexOf("async function startClaxedoServer("),
  entry.indexOf("async function setupServerConnection()"),
)
const setupServer = entry.slice(
  entry.indexOf("async function setupServerConnection()"),
  entry.indexOf("async function initialize()"),
)
// The same flow, on its other side. The server child owns the only stamp for
// "able to serve", so the cold startup wiring this file pins does not fit in
// one file.
const childEntry = readFileSync(
  path.join(import.meta.dir, "../../scripts/claxedo-server-entry.ts"),
  "utf8",
)

describe("desktop cold startup wiring", () => {
  test("loads the ordinary renderer while the embedded server starts", () => {
    const createWindow = initialize.indexOf("mainWindow = createMainWindow(globals)")
    const awaitServer = initialize.indexOf("await loadingTask")

    expect(createWindow).toBeGreaterThan(-1)
    expect(awaitServer).toBeGreaterThan(createWindow)
    expect(initialize).not.toContain("createMainWindow(globals, { deferLoad: true })")
  })

  test("publishes the server URL only after the renderer is granted daemon access", () => {
    const grant = initialize.indexOf("grantMainRendererDaemonAccess({")
    const publish = initialize.indexOf("serverReady.resolve({ url: serverConnection.url, password: null })")
    const stamp = initialize.indexOf('recordStartupClock("main-server-ready-published")')

    expect(grant).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(grant)
    expect(stamp).toBeGreaterThan(publish)
  })

  // The renderer's first request needs the capability to be admitted at all, so
  // the endpoint has to be resolved before the hook that reads it is installed.
  test("resolves the daemon endpoint before granting the renderer access", () => {
    const endpoint = initialize.indexOf("daemonEndpoint.resolve(endpoint)")
    const grant = initialize.indexOf("grantMainRendererDaemonAccess({")

    expect(endpoint).toBeGreaterThan(-1)
    expect(grant).toBeGreaterThan(endpoint)
  })

  // The capability is the one thing the renderer must never hold: it is
  // published to the page, and a page that can read it can drive the machine.
  test("never publishes the daemon capability to the renderer", () => {
    expect(initialize).toContain("serverReady.resolve({ url: serverConnection.url, password: null })")
    expect(entry).not.toMatch(/serverReady\.resolve\(\{[^}]*capability/)
    expect(entry).not.toMatch(/globals = \{[^}]*capability/)
  })

  test("waits for the exact listener message and verifies health without polling", () => {
    expect(serverStart).toContain("parseClaxedoServerReadyMessage(input)")
    expect(serverStart).toContain("await Promise.race([")
    expect(serverStart).toContain("/api/claxedo/health")
    expect(serverStart).not.toMatch(/for \(let i = 0; i < 50; i\+\+\)/)
  })

  // `prepare()` pays the HTTP client's one-time cost while this process is
  // blocked on the child; `verify()` is the check itself and must stay where it
  // was, after the listening message. Getting the order wrong turns a free
  // optimisation into either a no-op (prepare after the wait) or a deleted
  // guarantee (verify before it).
  test("pays the client's one-time cost before the wait and checks health after it", () => {
    const prepare = serverStart.indexOf("readiness.prepare()")
    // Anchored on the listening wait itself: `handle.close()` above also races,
    // so a bare `Promise.race([` matches the wrong statement.
    const wait = serverStart.indexOf("listening.promise,")
    const verify = serverStart.indexOf("await readiness.verify()")

    expect(prepare).toBeGreaterThan(-1)
    expect(wait).toBeGreaterThan(prepare)
    expect(verify).toBeGreaterThan(wait)
  })

  test("a published daemon is recovered, and a replacement starts only when the old one is gone", () => {
    const recover = setupServer.indexOf("await recoverPublishedDaemon({")
    const refuse = setupServer.indexOf("throw new DaemonUnresolvedError(discovery)")
    const start = setupServer.indexOf("await startClaxedoServer(serverDataDir)")

    expect(recover).toBeGreaterThan(-1)
    expect(refuse).toBeGreaterThan(recover)
    expect(start).toBeGreaterThan(refuse)
    expect(setupServer).toContain("authorize: () => false")
  })

  test("still closes the child when readiness fails", () => {
    const verify = serverStart.indexOf("await readiness.verify()")
    const close = serverStart.indexOf("await handle.close()")

    expect(close).toBeGreaterThan(verify)
    expect(serverStart.slice(verify)).toContain("} catch (error) {")
  })

  test("publishes serverReady only after renderer daemon access is installed", () => {
    const grant = initialize.indexOf("grantMainRendererDaemonAccess({")
    const publish = initialize.indexOf("serverReady.resolve(")
    expect(grant).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(grant)
  })
})

// The renderer cannot issue a request before `serverReady` publishes the URL,
// so the distance from "the server can serve" to "the renderer asks" is a
// property of THIS handoff and of nothing else. Stamping it is the only way to
// know whether a server-side prewarm has any window to run in. The stamps are
// diagnostics, so each one is placed AFTER the step it measures: a probe that
// can delay the step would be measuring a cost it created.
describe("startup clock probe placement", () => {
  test("the server child sends its ready message before it stamps", () => {
    const send = childEntry.indexOf("parent?.send(claxedoServerReadyMessage(startup.port))")
    const stamp = childEntry.indexOf('recordStartupClock("server-listening"')
    expect(send).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(send)
  })

  test("main stamps the ready message without displacing the listening resolution", () => {
    const stamp = serverStart.indexOf('recordStartupClock("main-server-ready-message"')
    const resolve = serverStart.indexOf("if (ready.port === claxedoPort) listening.resolve()")
    expect(stamp).toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(stamp)
  })

  test("main stamps health only once it has actually verified it", () => {
    const verified = serverStart.indexOf("await readiness.verify()")
    const stamp = serverStart.indexOf('recordStartupClock("main-server-health-verified")')
    expect(verified).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(verified)
  })

  test("main stamps the published URL after publishing it, never before", () => {
    const publish = initialize.indexOf("serverReady.resolve(")
    const stamp = initialize.indexOf('recordStartupClock("main-server-ready-published")')
    expect(publish).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(publish)
  })
})
