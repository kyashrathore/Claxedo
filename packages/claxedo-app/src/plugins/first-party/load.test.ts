import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { PluginManifest } from "@claxedo/plugin-api"
import type { PluginBuild } from "../model"
import type { FirstPartyBundle, PluginBundle } from "./model"

await mock.module("../frame/definition", () => ({ frameDefinition: () => ({ activate: () => undefined }) }))
await mock.module("../in-app", () => ({ importInApp: () => Promise.reject(new Error("not used")) }))
const { FIRST_PARTY_PLUGIN_IDS } = await import("@claxedo/plugin-api")
const { frameBundleLoader, loadFirstPartyPlugins } = await import("./load")

const manifest: PluginManifest = { id: "claxedo-tasks", name: "Tasks", version: "1.0.0", app: "./src/app/index.ts", requires: ["tasks"], server: { routes: [], operations: [] } }
const bundle: PluginBundle = { manifest, hash: "c".repeat(16), code: "export default {}" }

function entry(served: PluginBundle): FirstPartyBundle {
  return { id: "claxedo-tasks", load: () => Promise.resolve({ default: served }) }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let errors: ReturnType<typeof spyOn>
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => errors.mockRestore())

describe("loadFirstPartyPlugins", () => {
  test("puts each bundle as a build of bundled origin, with the manifest the bundle was built from", async () => {
    const put: PluginBuild[] = []
    loadFirstPartyPlugins([entry(bundle)], frameBundleLoader({} as never), (build) => put.push(build))
    await settle()
    expect(put.map((build) => [build.manifest, build.origin])).toEqual([[manifest, { kind: "bundled", hash: bundle.hash }]])
  })

  test("refuses a bundle that declares another plugin's id and logs why", async () => {
    const put: PluginBuild[] = []
    loadFirstPartyPlugins([entry({ ...bundle, manifest: { ...manifest, id: "fixture" } })], frameBundleLoader({} as never), (build) => put.push(build))
    await settle()
    expect(put).toEqual([])
    expect(String(errors.mock.calls[0]?.[0])).toContain("the bundle declares the id fixture")
  })

  test("puts nothing once the host stopped, and logs a chunk that failed to load", async () => {
    const put: PluginBuild[] = []
    const stop = loadFirstPartyPlugins([entry(bundle)], frameBundleLoader({} as never), (build) => put.push(build))
    stop()
    loadFirstPartyPlugins([{ id: "claxedo-tasks", load: () => Promise.reject(new Error("chunk 404")) }], frameBundleLoader({} as never), (build) => put.push(build))
    await settle()
    expect(put).toEqual([])
    expect(String(errors.mock.calls[0]?.[0])).toContain("The built-in app plugin claxedo-tasks could not be loaded: chunk 404")
  })
})

describe("FIRST_PARTY_BUNDLES", () => {
  test("ships one bundle per first-party plugin id", async () => {
    const { FIRST_PARTY_BUNDLES } = await import("./bundles")
    expect(FIRST_PARTY_BUNDLES.map((shipped) => shipped.id)).toEqual([...FIRST_PARTY_PLUGIN_IDS])
  })
})
