import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AppPluginsGrant } from "@claxedo/mcp/client"
import type { PluginsChangedEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { APP_PLUGIN_FOLDER, appPluginAuthoring } from "./authoring"
import { appPluginId, appPluginScaffold } from "./scaffold"
import { createLivePluginService, type LivePluginService } from "./service"

let root: string
let workspace: string
let outside: string
let service: LivePluginService
let events: PluginsChangedEvent[]
let authoring: AppPluginsGrant

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "app-plugin-authoring-")))
  workspace = path.join(root, "workspace")
  outside = path.join(root, "outside")
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(outside, { recursive: true })
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  await service?.settled()
  service?.dispose()
  await fs.rm(path.join(root, "data"), { recursive: true, force: true })
  await fs.rm(path.join(workspace, ".claxedo"), { recursive: true, force: true })
})

function fresh() {
  events = []
  service = createLivePluginService({ root: path.join(root, "data"), publish: (event) => events.push(event) })
  authoring = appPluginAuthoring({ roots: [workspace], service: () => service })
}

describe("appPluginScaffold", () => {
  test("derives the id from the display name and writes a manifest the daemon accepts", () => {
    const { manifest, files } = appPluginScaffold("  Standup Notes!  ")
    expect(manifest).toEqual({ id: "standup-notes", name: "Standup Notes!", version: "0.1.0", app: "./src/app.tsx", requires: [], server: { routes: [], operations: [] } })
    expect(Object.keys(files)).toEqual(["package.json", "src/app.tsx"])
    expect(JSON.parse(files["package.json"] ?? "")).toMatchObject({ name: "claxedo-plugin-standup-notes", private: true, type: "module", claxedo: manifest })
    expect(files["src/app.tsx"]).toContain(`api.sidebar.item({ id: "standup-notes", label: "Standup Notes!", pageId: "standup-notes" })`)
  })

  test("a name with no letters or digits makes no id", () => {
    expect(() => appPluginId("—!—")).toThrow("makes no plugin id")
  })
})

describe("appPluginAuthoring", () => {
  test("create scaffolds under the workspace's plugin folder, and the scaffold passes the check untouched", async () => {
    fresh()
    const created = await authoring.create({ name: "Standup notes" })
    const directory = path.join(workspace, APP_PLUGIN_FOLDER, "standup-notes")
    expect(created).toEqual({ id: "standup-notes", name: "Standup notes", directory, files: ["package.json", "src/app.tsx"] })
    expect(await authoring.check(directory)).toEqual({ directory, ok: true, pluginId: "standup-notes", diagnostics: [] })
  })

  test("check reports a planted type error by file and line, then passes once it is fixed", async () => {
    fresh()
    const { directory } = await authoring.create({ name: "Notes" })
    const app = path.join(directory, "src", "app.tsx")
    const source = await fs.readFile(app, "utf8")
    await fs.writeFile(app, source.replace(`label: "Notes"`, "label: 42"))
    const red = await authoring.check(directory)
    expect(red.ok).toBe(false)
    expect(red.diagnostics).toEqual([expect.objectContaining({ stage: "typecheck", file: path.join("src", "app.tsx"), code: "TS2322" })])
    await fs.writeFile(app, source)
    expect((await authoring.check(directory)).ok).toBe(true)
  })

  test("add registers the folder with the live-plugin service, which builds it and rings the app", async () => {
    fresh()
    const { directory } = await authoring.create({ name: "Notes" })
    expect(await authoring.add(directory)).toEqual({ id: "notes", name: "Notes", directory, status: "ready", lastError: null })
    expect(service.list().map((row) => row.id)).toEqual(["notes"])
    expect(events.map((event) => event.status)).toEqual(["building", "ready"])
  })

  test("create honours a chosen folder inside the workspace", async () => {
    fresh()
    const chosen = path.join(workspace, ".claxedo", "mine")
    expect((await authoring.create({ name: "Notes", directory: chosen })).directory).toBe(chosen)
  })

  test("refuses every folder outside the workspace, relative paths and symlinks that leave it", async () => {
    fresh()
    await expect(authoring.create({ name: "Notes", directory: path.join(outside, "notes") })).rejects.toThrow("is outside this session's workspace")
    await expect(authoring.create({ name: "Notes", directory: "notes" })).rejects.toThrow("is not an absolute path")
    await expect(authoring.create({ name: "Notes", directory: path.join(workspace, "..", "outside", "notes") })).rejects.toThrow("is outside")
    await fs.mkdir(path.join(outside, "plugin"), { recursive: true })
    const link = path.join(workspace, ".claxedo", "escape")
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.symlink(path.join(outside, "plugin"), link)
    await expect(authoring.create({ name: "Notes", directory: path.join(link, "notes") })).rejects.toThrow("is outside")
    await expect(authoring.check(outside)).rejects.toThrow("is outside")
    await expect(authoring.add(link)).rejects.toThrow("is outside")
    expect(await fs.readdir(path.join(outside, "plugin"))).toEqual([])
    expect(service.list()).toEqual([])
  })

  test("refuses to scaffold over a folder with content, or an id the daemon already serves", async () => {
    fresh()
    const occupied = path.join(workspace, ".claxedo", "occupied")
    await fs.mkdir(occupied, { recursive: true })
    await fs.writeFile(path.join(occupied, "keep.txt"), "mine")
    await expect(authoring.create({ name: "Notes", directory: occupied })).rejects.toThrow("already exists and is not empty")
    expect(await fs.readdir(occupied)).toEqual(["keep.txt"])

    const { directory } = await authoring.create({ name: "Notes" })
    await authoring.add(directory)
    await expect(authoring.create({ name: "Notes", directory: path.join(workspace, ".claxedo", "again") })).rejects.toThrow("already registered")
  })

  test("check and add refuse a folder that does not exist", async () => {
    fresh()
    await expect(authoring.check(path.join(workspace, "missing"))).rejects.toThrow("does not exist")
    await expect(authoring.add(path.join(workspace, "missing"))).rejects.toThrow("does not exist")
  })

  test("needs at least one folder to bind to", () => {
    expect(() => appPluginAuthoring({ roots: [] })).toThrow("at least one folder")
  })
})
