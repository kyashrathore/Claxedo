import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { withAppBundle } from "./local-app-bundle"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-e2e-bundle-"))
await fs.mkdir(path.join(root, "assets"))
await fs.writeFile(path.join(root, "index.html"), "<html>app</html>")
await fs.writeFile(path.join(root, "assets/app.js"), "export const app = true")
afterAll(() => fs.rm(root, { recursive: true, force: true }))

test("the local browser bundle serves scripts and SPA routes without changing API responses", async () => {
  const apiReply = Response.json({ ok: true }, { headers: { "content-security-policy": "default-src 'none'" } })
  const fetch = withAppBundle((request) => new URL(request.url).pathname === "/api/claxedo/health" ? apiReply : new Response("absent", { status: 404 }), root)
  expect(await fetch(new Request("http://localhost/api/claxedo/health"))).toBe(apiReply)
  const home = await fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }))
  expect(home.status).toBe(200)
  expect(await home.text()).toBe("<html>app</html>")
  const asset = await fetch(new Request("http://localhost/assets/app.js"))
  expect(asset.status).toBe(200)
  expect(asset.headers.get("content-type")).toContain("javascript")
  expect(await asset.text()).toBe("export const app = true")
  const page = await fetch(new Request("http://localhost/s/session", { headers: { accept: "text/html" } }))
  expect(await page.text()).toBe("<html>app</html>")
  expect(page.headers.get("content-security-policy")).not.toBe("default-src 'none'")
})

test("unknown API routes, mutations, missing assets and paths outside the bundle remain refused", async () => {
  const fetch = withAppBundle(() => new Response("absent", { status: 404 }), root)
  for (const [url, method] of [
    ["/api/unknown", "GET"], ["/session/unknown", "POST"],
    ["/assets/missing.js", "GET"], ["/..%2foutside.txt", "GET"],
  ]) {
    const reply = await fetch(new Request(`http://localhost${url}`, { method, headers: { accept: "text/html" } }))
    expect(reply.status).toBe(404)
  }
})
