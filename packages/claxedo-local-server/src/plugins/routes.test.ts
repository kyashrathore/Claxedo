import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginsChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { PLUGIN_RUNTIME_GLOBAL } from "@claxedo/plugin-api/runtime"
import { LivePluginRoutes } from "./routes"
import { createLivePluginService, type LivePluginRow, type LivePluginService } from "./service"

const unsigned = { enabled: false, mode: "local-only", reason: "local test" } as const

const APP = (label: string) => `import { createSignal } from "solid-js"
import { definePlugin } from "@claxedo/plugin-api"

function Page() {
  const [count] = createSignal(0)
  return <p>${label} {count()}</p>
}

export default definePlugin({
  activate(api) {
    return api.pages.register({ id: "notes", path: "/notes", title: "${label}", render: () => <Page /> })
  },
})
`

const PACKAGE_JSON = JSON.stringify({
  name: "claxedo-plugin-notes",
  version: "0.1.0",
  type: "module",
  claxedo: { id: "notes", name: "Notes", version: "0.1.0", app: "./src/app.tsx" },
})

let root: string
let folder: string
let service: LivePluginService
let events: PluginsChangedEvent[]
let app: ReturnType<typeof LivePluginRoutes>

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function listed(): Promise<LivePluginRow[]> {
  const response = await app.request("/")
  expect(response.status).toBe(200)
  return ((await response.json()) as { plugins: LivePluginRow[] }).plugins
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "live-plugins-routes-"))
  folder = path.join(root, "notes")
  await fs.mkdir(path.join(folder, "src"), { recursive: true })
  await fs.writeFile(path.join(folder, "package.json"), PACKAGE_JSON)
  await fs.writeFile(path.join(folder, "src", "app.tsx"), APP("Notes"))
  events = []
  service = createLivePluginService({ root: path.join(root, "data"), publish: (event) => events.push(event) })
  app = LivePluginRoutes({ authConfig: unsigned }, { service })
})

afterAll(async () => {
  service.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

describe("live plugin routes", () => {
  test("refuses a relative path, a missing folder and a folder without a manifest", async () => {
    expect((await app.request("/", json({ directory: "notes" }))).status).toBe(400)
    expect((await app.request("/", json({ directory: path.join(root, "nope") }))).status).toBe(404)
    const bare = path.join(root, "bare")
    await fs.mkdir(bare)
    const response = await app.request("/", json({ directory: bare }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "live_plugin_manifest_invalid" } })
    expect((await app.request("/", json({ folder }))).status).toBe(400)
  })

  test("adds a folder, builds it, lists it and serves the immutable bundle", async () => {
    const response = await app.request("/", json({ directory: folder }))
    expect(response.status).toBe(201)
    const row = (await response.json()) as LivePluginRow
    expect(row).toMatchObject({ id: "notes", name: "Notes", version: "0.1.0", status: "ready", lastError: null })
    expect(row.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(row.url).toBe(`/api/claxedo/live-plugins/notes/${row.hash}/app.js`)
    expect(events.map((event) => event.status)).toEqual(["building", "ready"])
    expect(await listed()).toEqual([row])

    const bundle = await app.request(`/notes/${row.hash}/app.js`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await bundle.text()).toContain(`globalThis.${PLUGIN_RUNTIME_GLOBAL}`)
    expect((await app.request(`/notes/${"0".repeat(16)}/app.js`)).status).toBe(404)
    expect((await app.request(`/notes/latest/app.js`)).status).toBe(400)

    const again = await app.request("/", json({ directory: folder }))
    expect(again.status).toBe(409)
  })

  test("a save rebuilds under a new hash and rings plugins.changed", async () => {
    const [before] = await listed()
    await fs.writeFile(path.join(folder, "src", "app.tsx"), APP("Notes v2"))
    await vi.waitFor(() => {
      const ready = events.filter((event) => event.status === "ready")
      expect(ready.at(-1)?.hash).not.toBe(before.hash)
    }, { timeout: 15_000, interval: 50 })
    const [after] = await listed()
    expect(after.status).toBe("ready")
    expect(after.hash).not.toBe(before.hash)
    expect(await (await app.request(`/notes/${after.hash}/app.js`)).text()).toContain("Notes v2")
    expect((await app.request(`/notes/${before.hash}/app.js`)).status).toBe(200)
  })

  test("a broken save keeps the last good bundle and reports the error", async () => {
    const [good] = await listed()
    await fs.writeFile(path.join(folder, "src", "app.tsx"), "export default definePlugin({")
    await vi.waitFor(() => {
      expect(events.at(-1)?.status).toBe("failed")
    }, { timeout: 15_000, interval: 50 })
    const [failed] = await listed()
    expect(failed.status).toBe("failed")
    expect(failed.hash).toBe(good.hash)
    expect(failed.lastError).toContain("app.tsx")
    expect(events.at(-1)).toMatchObject({ pluginId: "notes", status: "failed", hash: good.hash })
    expect((await app.request(`/notes/${good.hash}/app.js`)).status).toBe(200)
  })

  test("a restart serves the last good build before the first rebuild finishes", async () => {
    const [previous] = await listed()
    service.dispose()
    const restarted = createLivePluginService({ root: path.join(root, "data") })
    await restarted.ready
    expect(restarted.list()).toEqual([expect.objectContaining({ id: "notes", status: "building", hash: previous.hash, url: previous.url, name: "Notes" })])
    await restarted.settled()
    expect(restarted.list()[0]).toMatchObject({ status: "failed", hash: previous.hash })
    restarted.dispose()
  })

  test("removing a plugin drops its registry entry, its bundles and rings removed", async () => {
    const [row] = await listed()
    expect((await app.request("/notes", { method: "DELETE" })).status).toBe(204)
    expect(await listed()).toEqual([])
    expect((await app.request(`/notes/${row.hash}/app.js`)).status).toBe(404)
    expect(events.at(-1)).toMatchObject({ pluginId: "notes", status: "removed" })
    expect((await app.request("/notes", { method: "DELETE" })).status).toBe(404)
    expect((await app.request("/Not-An-Id", { method: "DELETE" })).status).toBe(400)
    expect(JSON.parse(await fs.readFile(path.join(root, "data", "registry.json"), "utf8"))).toEqual({ version: 1, plugins: [] })
  })
})
