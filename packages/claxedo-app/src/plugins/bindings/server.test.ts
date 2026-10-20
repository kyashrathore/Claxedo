import { describe, expect, test } from "bun:test"
import type { PluginManifest } from "@claxedo/plugin-api"
import { PluginAccessError, serverBinding } from "./server"
import type { BindingScope } from "./services"

const manifest: PluginManifest = {
  id: "counter",
  name: "Counter",
  version: "0.1.0",
  app: "./src/app.js",
  requires: [],
  server: { routes: [], operations: ["plugin.*"] },
  backend: { entry: "./src/backend.js", objects: [], outbound: [], routes: ["GET /count"] },
}

function scoped(declared: PluginManifest) {
  const backend: [string, string, string | undefined][] = []
  const operations: string[] = []
  const calls = {
    backendFetch: async (pluginId: string, path: string, init?: RequestInit) => {
      backend.push([pluginId, path, init?.method])
      return Response.json({ value: 1 })
    },
    operation: async (name: string) => {
      operations.push(name)
      return undefined
    },
  }
  const scope = { manifest: declared, signal: new AbortController().signal, services: { calls } } as unknown as BindingScope
  return { server: serverBinding(scope), backend, operations }
}

describe("server.backend()", () => {
  test("reaches only the calling plugin's own backend, under the path it names", async () => {
    const { server, backend } = scoped(manifest)
    expect(await (await server.backend().fetch("/count?at=1", { method: "POST" })).json()).toEqual({ value: 1 })
    await server.backend().fetch("/../other/count")
    expect(backend).toEqual([
      ["counter", "/count?at=1", "POST"],
      ["counter", "/other/count", undefined],
    ])
  })

  test("is refused for a manifest that declares no backend, and for a path that is not the server's own", async () => {
    const { server } = scoped({ ...manifest, backend: undefined })
    expect(() => server.backend()).toThrow(PluginAccessError)
    await expect(scoped(manifest).server.backend().fetch("https://elsewhere.test/count")).rejects.toThrow(PluginAccessError)
  })

  test("is the only way to a backend: server.operation refuses plugin.request even where the manifest names it", async () => {
    const { server, operations } = scoped(manifest)
    await expect(server.operation("plugin.request", { pluginId: "other", method: "GET", path: "/" })).rejects.toThrow(PluginAccessError)
    await server.operation("plugin.list")
    expect(operations).toEqual(["plugin.list"])
  })
})
