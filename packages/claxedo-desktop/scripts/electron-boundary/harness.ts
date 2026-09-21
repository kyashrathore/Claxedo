/**
 * The renderer/daemon boundary, driven by the installed Electron.
 *
 * `renderer-daemon-access.test.ts` exercises the policy against structs this
 * repository wrote. That cannot establish what Electron actually hands a
 * listener, and the boundary rests entirely on those shapes: whether
 * `details.frame` exists for a `file://` document's fetch, whether a top frame's
 * `parent` is `null` or `undefined`, whether `webContentsId` is populated, and
 * which `Origin` Chromium sends from an opaque-origin page on HTTP versus a
 * WebSocket handshake. This process measures all of them and reports what it
 * saw rather than what the policy expects.
 *
 * Everything runs in a temporary `userData` directory under hidden windows, so
 * no profile of the user's own is read or written.
 *
 * It imports the real `grantMainRendererDaemonAccess`, the real caller registry
 * (`ipc-caller-guard`) and the real document-trust rule (`renderer-url-trust`),
 * and installs the listener on `session.defaultSession` exactly as `main/index`
 * does. The only addition is a tee that records each listener input BEFORE the
 * policy runs — an observation, not a second policy.
 *
 * Output: one `CLAXEDO_BOUNDARY_RESULT <json>` line on stdout.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import path from "node:path"
import type { Duplex } from "node:stream"
import { pathToFileURL } from "node:url"

import { app, BrowserWindow, session } from "electron"

import { readRecord, readString, readUnknown } from "../../src/shared/json-read"
import { CLAXEDO_DAEMON_CAPABILITY_HEADER } from "../../src/main/daemon-request"
import { mainIpcCallerGuard, trustWindowWithBridge } from "../../src/main/ipc-caller-guard"
import { MAIN_RENDERER_DOCUMENT } from "../../src/main/navigation-guard"
import { grantMainRendererDaemonAccess } from "../../src/main/renderer-daemon-access"
import { isTrustedRendererDocumentUrl } from "../../src/main/renderer-url-trust"

const CAPABILITY = "electron-boundary-capability-3f9a1c"

/**
 * Every file this run writes goes under one directory the PARENT chose, so the
 * test that spawned this process can remove all of it once the process is gone.
 * A child that cleans up after itself cannot remove a `userData` directory
 * Electron still holds open, which is how these leak.
 */
function workingDirectory(name: string): string {
  const root = process.env.CLAXEDO_BOUNDARY_ROOT
  if (!root) throw new Error("the boundary harness requires CLAXEDO_BOUNDARY_ROOT, the parent's temporary directory")
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The renderer webPreferences, production-equivalent.
 *
 * `windows.ts` creates the main window with `sandbox: false` (its preload needs
 * Node) and `webviewTag` on when the browser tab ships, and sets nothing else —
 * so `contextIsolation: true` / `nodeIntegration: false` are Electron's
 * defaults in both places. A boundary measured under different preferences
 * would be measuring a window this product never opens;
 * `renderer-daemon-access.electron.test.ts` holds the two together.
 */
const RENDERER_WEB_PREFERENCES = { sandbox: false, webviewTag: true } as const

/** What the daemon's listener saw on one request, by the label that made it. */
type Seen = {
  capability: string | null
  origin: string | null
  method: string
}

/** What the hook was handed, before the policy read it. */
type ListenerInput = {
  url: string
  hasFrame: boolean
  frameParent: "null" | "undefined" | "frame" | "unreadable"
  webContentsId: number | null
  incomingOrigin: string | null
}

const seen = new Map<string, Seen>()
const listenerInputs: ListenerInput[] = []
const externalHits: Array<{ capability: string | null }> = []

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  return typeof value === "string" ? value : Array.isArray(value) ? (value[0] ?? null) : null
}

function record(label: string, request: IncomingMessage) {
  seen.set(label, {
    capability: headerOf(request, CLAXEDO_DAEMON_CAPABILITY_HEADER),
    origin: headerOf(request, "origin"),
    method: request.method ?? "",
  })
}

/** Server-to-client text frame; unmasked, with the two lengths a short JSON needs. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8")
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

function label(url: string | undefined): string {
  return new URL(url ?? "/", "http://127.0.0.1").searchParams.get("w") ?? "unlabelled"
}

/**
 * The page never learns the capability: the probe answers booleans, so a test
 * page cannot become the leak it is meant to disprove.
 */
function probeBody(entry: Seen | undefined) {
  return JSON.stringify({ capability: entry?.capability !== null, origin: entry?.origin ?? null })
}

function startExternal(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    externalHits.push({ capability: headerOf(request, CLAXEDO_DAEMON_CAPABILITY_HEADER) })
    response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" })
    response.end("collected")
  })
  return listen(server)
}

function startDaemon(externalOrigin: () => string): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const cors = { "access-control-allow-origin": "*" }
    if (url.pathname === "/redirect-external") {
      record(`redirect:${label(request.url)}`, request)
      response.writeHead(302, { ...cors, location: `${externalOrigin()}/collect` })
      response.end()
      return
    }
    if (url.pathname === "/guest-page") {
      response.writeHead(200, { ...cors, "content-type": "text/html" })
      response.end(`<!doctype html><meta charset="utf-8"><script>
        fetch("/probe?w=${label(request.url)}").catch(() => {})
      </script>`)
      return
    }
    if (url.pathname === "/probe") {
      const key = label(request.url)
      record(key, request)
      response.writeHead(200, { ...cors, "content-type": "application/json" })
      response.end(probeBody(seen.get(key)))
      return
    }
    response.writeHead(404, cors)
    response.end()
  })
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    const key = `ws:${label(request.url)}`
    record(key, request)
    const accept = createHash("sha1")
      .update(`${headerOf(request, "sec-websocket-key") ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.write(textFrame(probeBody(seen.get(key))))
  })
  return listen(server)
}

function listen(server: Server): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("the harness server bound no port"))
        return
      }
      resolve({ server, origin: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

function pageDirectory(daemonOrigin: string): string {
  const dir = workingDirectory("pages")
  const origin = JSON.stringify(daemonOrigin)
  // The trusted document, by the name `renderer-url-trust` trusts. Its subframe
  // and its guest are the untrusted callers that share this window; both are
  // created from script so each carries the label of the window that made it.
  writeFileSync(
    path.join(dir, MAIN_RENDERER_DOCUMENT),
    `<!doctype html><meta charset="utf-8"><title>boundary</title><body>
<script>
  const w = new URLSearchParams(location.search).get("w") || "unlabelled"
  const frame = document.createElement("iframe")
  frame.src = "./frame.html?w=" + w + "-iframe"
  document.body.appendChild(frame)
  const guest = document.createElement("webview")
  guest.setAttribute("src", ${origin} + "/guest-page?w=" + w + "-guest")
  guest.setAttribute("style", "width:8px;height:8px")
  document.body.appendChild(guest)
</script></body>`,
  )
  writeFileSync(
    path.join(dir, "frame.html"),
    `<!doctype html><meta charset="utf-8"><script>
  const w = new URLSearchParams(location.search).get("w") || "unlabelled"
  fetch(${origin} + "/probe?w=" + w).catch(() => {})
</script>`,
  )
  // Same window, same webContents, a document the trust rule does not name.
  writeFileSync(path.join(dir, "untrusted.html"), `<!doctype html><meta charset="utf-8"><title>untrusted</title>`)
  return dir
}

/** Runs in the page: the fetch and the socket a real renderer makes. */
function pageProbe(daemonOrigin: string, label: string): string {
  return `(async () => {
    await fetch(${JSON.stringify(daemonOrigin)} + "/probe?w=" + ${JSON.stringify(label)}).catch(() => {})
    const socket = await new Promise((resolve) => {
      const ws = new WebSocket(${JSON.stringify(daemonOrigin.replace("http:", "ws:"))} + "/socket?w=" + ${JSON.stringify(label)})
      const settle = (opened, first) => resolve({ opened, first })
      ws.addEventListener("open", () => {
        ws.addEventListener("message", (event) => settle(true, String(event.data)), { once: true })
        setTimeout(() => settle(true, null), 3000)
      }, { once: true })
      ws.addEventListener("error", () => settle(false, null), { once: true })
      setTimeout(() => settle(false, null), 8000)
    })
    return { socket }
  })()`
}

/**
 * Everything the page can reach, serialized for main to search.
 *
 * Main holds the capability and does the searching; handing the page the string
 * to look for would be the disclosure this is meant to rule out.
 */
const PAGE_SURFACES = `(() => {
  const dump = (store) => { try { return JSON.stringify({ ...store }) } catch { return "" } }
  return [
    Object.keys(window).join(","),
    document.documentElement.outerHTML,
    document.cookie,
    dump(localStorage),
    dump(sessionStorage),
    JSON.stringify(performance.getEntriesByType("resource").map((entry) => entry.name)),
    JSON.stringify(Object.keys(globalThis)),
  ].join("\\n")
})()`

/**
 * Waits, and gives up quietly.
 *
 * A surface that never reported is an absent record, which the test asserts on
 * by name. Throwing here would discard every other measurement this run made
 * and replace a precise failure with a blank one.
 */
async function until(condition: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function main() {
  const external = await startExternal()
  const daemon = await startDaemon(() => external.origin)
  const pages = pageDirectory(daemon.origin)
  const trustedDocument = path.join(pages, MAIN_RENDERER_DOCUMENT)
  const packagedIndexUrl = pathToFileURL(trustedDocument).href

  grantMainRendererDaemonAccess({
    policy: {
      daemonOrigin: daemon.origin,
      capability: CAPABILITY,
      // The real registry the IPC boundary trusts, asked the same way `main/index` asks it.
      isBridgeCarryingWebContents: (id) => mainIpcCallerGuard().check({ senderId: id, isMainFrame: true }).allowed,
      // The real rule, with no development origin: a packaged desktop trusts one file.
      isTrustedDocumentUrl: (url) => isTrustedRendererDocumentUrl(url, { packagedIndexUrl }),
    },
    onBeforeSendHeaders: (filter, listener) => {
      session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        let frameParent: ListenerInput["frameParent"] = "unreadable"
        try {
          const parent = details.frame?.parent
          frameParent = details.frame ? (parent === null ? "null" : parent === undefined ? "undefined" : "frame") : "unreadable"
        } catch {
          frameParent = "unreadable"
        }
        const origin = Object.entries(details.requestHeaders)
          .find(([name]) => name.toLowerCase() === "origin")?.[1]
        listenerInputs.push({
          url: details.url,
          hasFrame: !!details.frame,
          frameParent,
          webContentsId: details.webContentsId ?? null,
          incomingOrigin: origin ?? null,
        })
        listener(details, callback)
      })
    },
  })

  const open = (trust: boolean) => {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      webPreferences: { ...RENDERER_WEB_PREFERENCES },
    })
    if (trust) {
      trustWindowWithBridge({
        webContentsId: win.webContents.id,
        onDestroyed: (listener) => win.webContents.once("destroyed", listener),
      })
    }
    return win
  }

  const load = (win: BrowserWindow, file: string, search: string) =>
    new Promise<void>((resolve, reject) => {
      win.webContents.once("did-finish-load", () => resolve())
      win.webContents.once("did-fail-load", (_event, code, description) =>
        reject(new Error(`${file} failed to load: ${String(code)} ${description}`)))
      void win.loadFile(path.join(pages, file), { search })
    })

  const trusted = open(true)
  await load(trusted, MAIN_RENDERER_DOCUMENT, "w=trusted")
  // `executeJavaScript` resolves `any`, so what the page returned is read
  // rather than asserted: a page that answered the wrong shape must read as an
  // absent measurement, not as a passing one.
  const probed: unknown = await trusted.webContents.executeJavaScript(pageProbe(daemon.origin, "trusted"))
  const socket = readRecord(probed, "socket")
  const socketOpened = readUnknown(socket, "opened") === true
  const socketFirstMessage = readString(socket, "first") ?? null
  const surfaces = readString({ text: await trusted.webContents.executeJavaScript(PAGE_SURFACES) }, "text") ?? ""

  // The subframe and the guest share this window; both are their own callers.
  await until(() => seen.has("trusted-iframe") && seen.has("trusted-guest"), 20_000)

  // A redirect is the hop a daemon-scoped filter cannot reach.
  await trusted.webContents.executeJavaScript(
    `fetch(${JSON.stringify(daemon.origin)} + "/redirect-external?w=trusted").then(() => {}, () => {})`,
  )
  await until(() => externalHits.length > 0)

  // An unregistered webContents showing the very same trusted document: the
  // document is not the reason it is refused, the webContents is.
  const unregistered = open(false)
  await load(unregistered, MAIN_RENDERER_DOCUMENT, "w=unregistered")
  await unregistered.webContents.executeJavaScript(
    `fetch(${JSON.stringify(daemon.origin)} + "/probe?w=unregistered").catch(() => {})`,
  )
  await until(() => seen.has("unregistered"))

  // The trusted window, once it is showing some other document.
  await load(trusted, "untrusted.html", "w=navigated")
  await trusted.webContents.executeJavaScript(
    `fetch(${JSON.stringify(daemon.origin)} + "/probe?w=navigated").catch(() => {})`,
  )
  await until(() => seen.has("navigated"))

  const result = {
    // Provenance in the artifact itself: only a real Electron main process can
    // report this, so a reader of the recorded run can tell it from a fixture.
    electronVersion: process.versions.electron ?? null,
    chromeVersion: process.versions.chrome ?? null,
    platform: process.platform,
    // Which Chromium sandbox this evidence was produced under, stated rather
    // than assumed. The parent decides; this only reports what it was given.
    chromiumSandbox: !app.commandLine.hasSwitch("no-sandbox"),
    webPreferences: { ...RENDERER_WEB_PREFERENCES },
    capabilityLength: CAPABILITY.length,
    daemonOrigin: daemon.origin,
    trustedDocumentUrl: packagedIndexUrl,
    seen: Object.fromEntries(seen),
    listenerInputs,
    externalHits,
    socketOpened,
    socketFirstMessage,
    capabilityInPageSurfaces: surfaces.includes(CAPABILITY),
    pageSurfaceBytes: surfaces.length,
  }
  process.stdout.write(`CLAXEDO_BOUNDARY_RESULT ${JSON.stringify(result)}\n`)

  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  external.server.close()
  daemon.server.close()
}

function failed(error: unknown): never {
  process.stderr.write(`boundary harness failed: ${String(error instanceof Error ? error.stack : error)}\n`)
  // `process.exit` rather than `app.exit`: this also runs before the app exists,
  // and a throw out of module scope leaves Electron exiting 0 — an exit code the
  // parent could not then trust.
  process.exit(1)
}

try {
  app.disableHardwareAcceleration()
  app.setName(`claxedo-boundary-${String(process.pid)}`)
  // Must precede `whenReady`, so it cannot move inside `main`.
  app.setPath("userData", workingDirectory("userData"))
  app.whenReady().then(main).then(() => app.exit(0), failed)
} catch (error) {
  failed(error)
}
