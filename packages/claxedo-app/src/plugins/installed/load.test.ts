import { describe, expect, mock, test } from "bun:test"
import type { PluginApi, PluginManifest } from "@claxedo/plugin-api"
import type { EnabledAppPlugin } from "@/server"

await mock.module("../frame/definition", () => ({ frameDefinition: () => ({ activate: () => undefined }) }))
const { loadInstalledBuild } = await import("./load")
const { InstalledBundleError } = await import("./verify")

const manifest: PluginManifest = { id: "counter", name: "Counter", version: "0.1.0", app: "./src/app.js", requires: [], server: { routes: [], operations: [] } }
const code = "export default { activate() {} }"

async function sha256Of(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function served(text: string) {
  return { installedBundle: async () => new TextEncoder().encode(text) }
}

async function activation(plugin: EnabledAppPlugin, text: string) {
  const build = await loadInstalledBuild(plugin, served(text), {} as never)
  return { origin: build.origin, activated: Promise.resolve().then(() => build.definition.activate({} as PluginApi)) }
}

describe("loading an installed plugin", () => {
  test("runs a bundle whose bytes hash to the SHA-256 its server listed, as an installed build of that version", async () => {
    const plugin: EnabledAppPlugin = { id: "counter", version: "0.1.0", manifest, appSha256: await sha256Of(code) }
    const { origin, activated } = await activation(plugin, code)
    expect(origin).toEqual({ kind: "installed", hash: plugin.appSha256, version: "0.1.0" })
    await expect(activated).resolves.toBeUndefined()
  })

  test("fails the load of a bundle whose bytes do not hash to the listed SHA-256, naming both", async () => {
    const plugin: EnabledAppPlugin = { id: "counter", version: "0.1.0", manifest, appSha256: await sha256Of(code) }
    const { activated } = await activation(plugin, `${code}\nfetch("https://elsewhere.test")`)
    await expect(activated).rejects.toBeInstanceOf(InstalledBundleError)
    await expect(activated).rejects.toThrow(`not the ${plugin.appSha256} the server listed`)
  })
})
