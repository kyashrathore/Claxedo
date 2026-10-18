import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { WORKER_FIRST_PATHS, publicOriginRoute } from "./public-origin"

const HEADERS = path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers")
const ORIGIN = "https://app.test"

const CONTROL_PLANE_STUB = `
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/cp/events") {
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("event: first\\n\\n"))
          await new Promise((resolve) => setTimeout(resolve, 400))
          controller.enqueue(encoder.encode("event: second\\n\\n"))
          controller.close()
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const seen = {
      url: request.url,
      method: request.method,
      cookie: request.headers.get("cookie"),
      body: request.method === "POST" ? await request.text() : null,
      country: request.cf?.country ?? null,
    }
    return Response.json(seen, { headers: { "set-cookie": "__Secure-claxedo.session_token=minted; Path=/; Secure; HttpOnly" } })
  },
}
`

const RELAY_STUB = `
export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair()
      const [client, server] = [pair[0], pair[1]]
      server.accept()
      server.addEventListener("message", (event) => server.send("echo " + url.pathname + " " + event.data))
      server.addEventListener("close", (event) => server.close(event.code, event.reason))
      return new Response(null, { status: 101, webSocket: client })
    }
    return Response.json({ url: request.url, authorization: request.headers.get("authorization"), country: request.cf?.country ?? null })
  },
}
`

let workDir: string
let mf: Miniflare

beforeAll(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "app-worker-"))
  const assets = path.join(workDir, "dist")
  await mkdir(path.join(assets, "assets"), { recursive: true })
  await copyFile(HEADERS, path.join(assets, "_headers"))
  await writeFile(path.join(assets, "index.html"), "<!doctype html><script type=\"module\" src=\"/assets/main-new.js\"></script>")
  await writeFile(path.join(assets, "assets", "main-new.js"), "export {}")
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./app-worker.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false,
  })
  mf = new Miniflare({
    workers: [
      {
        name: "app",
        modules: true,
        script: bundled.outputFiles[0].text,
        compatibilityDate: "2025-05-01",
        serviceBindings: { CONTROL_PLANE: "control-plane", RELAY: "relay" },
        assets: {
          directory: assets,
          binding: "ASSETS",
          routerConfig: { has_user_worker: true, static_routing: { user_worker: [...WORKER_FIRST_PATHS] } },
          assetConfig: { not_found_handling: "single-page-application", html_handling: "auto-trailing-slash" },
        },
      },
      { name: "control-plane", modules: true, script: CONTROL_PLANE_STUB, compatibilityDate: "2025-05-01" },
      { name: "relay", modules: true, script: RELAY_STUB, compatibilityDate: "2025-05-01" },
    ],
  })
  await mf.ready
}, 120_000)

afterAll(async () => {
  await mf?.dispose()
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

const serve = (pathname: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) => mf.dispatchFetch(`${ORIGIN}${pathname}`, init)

describe("the public origin's routes", () => {
  test("names the Worker a path belongs to", () => {
    expect(publicOriginRoute("/api/claxedo/mode")).toBe("control-plane")
    expect(publicOriginRoute("/internal/relay/target")).toBe("control-plane")
    expect(publicOriginRoute("/.well-known/jwks.json")).toBe("control-plane")
    expect(publicOriginRoute("/health")).toBe("control-plane")
    expect(publicOriginRoute("/relay/workspaces/ws_1/session")).toBe("relay")
    expect(publicOriginRoute("/relay")).toBe("assets")
    expect(publicOriginRoute("/relayed")).toBe("assets")
    expect(publicOriginRoute("/healthy")).toBe("assets")
    expect(publicOriginRoute("/w/ws_1/session/ses_1")).toBe("assets")
    expect(publicOriginRoute("/assets/main.js")).toBe("assets")
  })
})

describe("the control plane behind the public origin", () => {
  test("receives the request on the public origin with its cookie, and its Set-Cookie reaches the browser", async () => {
    const response = await serve("/api/claxedo/mode", { headers: { cookie: "__Secure-claxedo.session_token=held" } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ url: `${ORIGIN}/api/claxedo/mode`, method: "GET", cookie: "__Secure-claxedo.session_token=held", country: "US" })
    expect(response.headers.get("set-cookie")).toContain("__Secure-claxedo.session_token=minted")
  })

  test("forwards a JSON body, the resolver's internal routes, the OAuth metadata and the health probe", async () => {
    const posted = await serve("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"name\":\"ws\"}" })
    expect(await posted.json()).toMatchObject({ method: "POST", body: "{\"name\":\"ws\"}" })
    for (const pathname of ["/internal/relay/target?workspaceId=ws_1", "/.well-known/oauth-authorization-server", "/health"]) {
      expect(await (await serve(pathname)).json()).toMatchObject({ url: `${ORIGIN}${pathname}` })
    }
  })

  test("streams an event stream chunk by chunk", async () => {
    const response = await serve("/api/cp/events")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const startedAt = Date.now()
    const first = await reader.read()
    const firstAt = Date.now() - startedAt
    expect(decoder.decode(first.value)).toBe("event: first\n\n")
    const second = await reader.read()
    expect(decoder.decode(second.value)).toBe("event: second\n\n")
    expect(Date.now() - startedAt - firstAt).toBeGreaterThanOrEqual(300)
    expect((await reader.read()).done).toBe(true)
  })
})

describe("the relay behind the public origin", () => {
  test("sees the path without the prefix, the bearer token and the edge country", async () => {
    const response = await serve("/relay/workspaces/ws_1/api/wr/health?region=apac", { headers: { authorization: "Bearer rat" } })
    expect(await response.json()).toEqual({ url: `${ORIGIN}/workspaces/ws_1/api/wr/health?region=apac`, authorization: "Bearer rat", country: "US" })
  })

  test("passes a WebSocket upgrade through and the socket carries frames both ways", async () => {
    const response = await serve("/relay/workspaces/ws_1/pty", { headers: { upgrade: "websocket" } })
    expect(response.status).toBe(101)
    const socket = response.webSocket
    if (!socket) throw new Error("the upgrade answered no socket")
    socket.accept()
    const echoed = new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(typeof event.data === "string" ? event.data : "")))
    socket.send("keys")
    expect(await echoed).toBe("echo /workspaces/ws_1/pty keys")
    const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()))
    socket.close()
    await closed
  })
})

describe("the app's assets", () => {
  test("a chunk a newer deploy removed answers 404 uncached, not the shell as a module", async () => {
    const response = await serve("/assets/terminal-creator-OLD.js")
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("")
  })

  test("a present chunk passes through with its immutable caching", async () => {
    const response = await serve("/assets/main-new.js")
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("export {}")
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  test("client routes outside the forwarded paths keep the single-page fallback", async () => {
    for (const pathname of ["/w/workspace-1/session/ses_1", "/relay", "/healthy"]) {
      const response = await serve(pathname)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("main-new.js")
    }
  })
})
