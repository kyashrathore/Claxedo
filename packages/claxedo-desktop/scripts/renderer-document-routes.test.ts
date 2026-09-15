import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer, type ViteDevServer } from "vite"
import { createElectronRenderer } from "../vite.renderer"
import { MAIN_RENDERER_DOCUMENT } from "../src/main/navigation-guard"

let server: ViteDevServer
let origin: string
beforeAll(async () => {
  server = await createServer({
    ...createElectronRenderer("development"),
    configFile: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, preTransformRequests: false },
  })
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("Vite TCP address unavailable")
  origin = `http://127.0.0.1:${address.port}`
})
afterAll(async () => { await server?.close() })

test("direct navigation and reload use the canonical desktop renderer document", async () => {
  for (const route of ["/", "/s/57caae86-8783-4107-837e-0da8524faca1", "/s/session?view=review", `/${MAIN_RENDERER_DOCUMENT}`]) {
    const response = await fetch(`${origin}${route}`, { headers: { accept: "text/html" } })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('id="root"')
    expect(html).toContain('/local.tsx')
    expect(html).toContain('/@vite/client')
  }
})

test("missing assets and API routes stay missing instead of receiving renderer HTML", async () => {
  for (const route of ["/missing.js", "/assets/missing.css", "/api/missing", "/src/missing", "/missing.html"]) {
    const response = await fetch(`${origin}${route}`, { headers: { accept: "*/*" } })
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('id="root"')
  }
  const json = await fetch(`${origin}/s/session`, { headers: { accept: "application/json" } })
  expect(json.status).toBe(404)
  const post = await fetch(`${origin}/s/session`, { method: "POST", headers: { accept: "text/html" } })
  expect(post.status).toBe(404)
})
