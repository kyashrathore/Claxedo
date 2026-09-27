import { afterEach, beforeEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PLUGIN_BUNDLE_HASH_LENGTH } from "@claxedo/plugin-build"
import { readCurrentLivePluginBundle, saveLivePluginBundle } from "./bundles"
import { livePluginRegistryFile, readLivePluginRegistry, writeLivePluginRegistry } from "./registry"

const manifest = { id: "notes", name: "Notes", version: "0.1.0", app: "./src/app.tsx", requires: [], server: { routes: [], operations: [] } }
const bundle = { hash: "a".repeat(PLUGIN_BUNDLE_HASH_LENGTH), manifest, builtAt: "2026-09-25T10:00:00.000Z" }

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "live-plugins-store-"))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("live plugin store permissions", () => {
  test("the registry is written owner-only", async () => {
    const entries = [{ id: "notes", directory: "/work/notes", addedAt: "2026-09-25T10:00:00.000Z" }]
    await writeLivePluginRegistry(root, entries)
    expect((await fs.stat(livePluginRegistryFile(root))).mode & 0o777).toBe(0o600)
    expect(await readLivePluginRegistry(root)).toEqual(entries)
  })

  test("a bundle's current.json is written owner-only", async () => {
    await saveLivePluginBundle(root, "notes", { ...bundle, code: "export {}" })
    expect((await fs.stat(path.join(root, "bundles", "notes", "current.json"))).mode & 0o777).toBe(0o600)
    expect(await readCurrentLivePluginBundle(root, "notes")).toEqual(bundle)
  })
})
