import { afterAll, beforeAll, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PluginsChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { writeLivePluginRegistry } from "./registry"
import { LivePluginRoutes } from "./routes"
import { createLivePluginService, type LivePluginRow, type LivePluginService } from "./service"

vi.mock("@claxedo/plugin-build", () => {
  throw new Error("the staged toolchain is broken")
})

const unsigned = { enabled: false, mode: "local-only", reason: "local test" } as const

let root: string
let service: LivePluginService

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "live-plugins-toolchain-"))
})

afterAll(async () => {
  service.dispose()
  await fs.rm(root, { recursive: true, force: true })
})

test("a registered plugin whose toolchain cannot load is listed as failed, naming the load", async () => {
  const data = path.join(root, "data")
  await writeLivePluginRegistry(data, [{ id: "notes", directory: path.join(root, "notes"), addedAt: new Date().toISOString() }])
  const events: PluginsChangedEvent[] = []
  service = createLivePluginService({ root: data, publish: (event) => events.push(event) })
  const app = LivePluginRoutes({ authConfig: unsigned }, { service })

  await service.settled()
  const response = await app.request("/")
  expect(response.status).toBe(200)
  const [row] = ((await response.json()) as { plugins: LivePluginRow[] }).plugins
  expect(row).toMatchObject({ id: "notes", status: "failed", hash: null })
  expect(row.lastError).toContain("The plugin toolchain failed to load")
  expect(events.at(-1)).toMatchObject({ pluginId: "notes", status: "failed" })
})
