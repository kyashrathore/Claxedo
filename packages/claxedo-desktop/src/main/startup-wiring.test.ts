import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// Electron main cannot be imported in a unit process because importing it boots
// the application. Pin the ordering at the real entry instead: renderer load
// may overlap the server, but serverReady must still be resolved only after the
// origin hook and verified health boundary are installed.
const entry = readFileSync(path.join(import.meta.dir, "index.ts"), "utf8")
const initialize = entry.slice(entry.indexOf("async function initialize()"), entry.indexOf("function showMainWindow"))
const serverStart = entry.slice(
  entry.indexOf("async function startClaxedoServer()"),
  entry.indexOf("async function setupServerConnection()"),
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

  test("keeps first-run migrations on their progress-window path", () => {
    expect(initialize).toContain("needsMigration ? createLoadingWindow(globals) : undefined")
    expect(initialize).toContain("await loadingComplete.promise")
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

  test("still closes the child when readiness fails", () => {
    const verify = serverStart.indexOf("await readiness.verify()")
    const close = serverStart.indexOf("await handle.close()")

    expect(close).toBeGreaterThan(verify)
    expect(serverStart.slice(verify)).toContain("} catch (error) {")
  })

  test("publishes serverReady only after renderer-origin trust is installed", () => {
    const trust = initialize.indexOf("trustMainRendererOrigin({")
    const publish = initialize.indexOf("serverReady.resolve(")
    expect(trust).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(trust)
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
