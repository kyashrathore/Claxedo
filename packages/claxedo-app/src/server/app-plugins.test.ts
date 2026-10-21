import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { createAppPluginsApi } from "./app-plugins"
import type { Transport } from "./transport"
import type { PluginActivationInput } from "./marketplace-types"
import { queryKeys } from "./query-keys"
import { appPluginInstallsFromWire, enabledAppPluginsFromWire } from "./wire/app-plugins"

const transport = {
  serverUrl: "https://app.test",
  request: async (path: string, init?: RequestInit) => new Response(JSON.stringify({ path, method: init?.method ?? "GET" }), { headers: { "content-type": "application/json" } }),
} as unknown as Transport

const activations: PluginActivationInput[] = []
const marketplace = {
  setActivation: async (input: PluginActivationInput) => {
    activations.push(input)
    return { revision: input.revision + 1, reconciliation: { state: "applied" as const } }
  },
}

function bridge(answer: unknown) {
  const runs: [string, unknown][] = []
  const port = {
    run: async (operation: string, input?: unknown) => {
      runs.push([operation, input])
      return answer
    },
  } as unknown as HostedAccount
  return { port, runs }
}

describe("the app plugins adapter", () => {
  test("offers nothing to an unsigned app", () => {
    expect(createAppPluginsApi({ transport, queryClient: new QueryClient(), account: undefined, port: undefined, marketplace })).toBeUndefined()
  })

  test("on the web, reaches a plugin's backend on the app's own server under that plugin's prefix", async () => {
    const { port: account } = bridge(undefined)
    const api = createAppPluginsApi({ transport, queryClient: new QueryClient(), account, port: undefined, marketplace })
    expect(await (await api!.backendFetch("counter", "/count", { method: "POST" })).json()).toEqual({ path: "/api/plugins/counter/count", method: "POST" })
  })

  test("on a signed desktop, crosses plugin.request with the plugin's own id and answers its status and JSON body", async () => {
    const { port, runs } = bridge({ status: 201, body: { value: 2 } })
    const api = createAppPluginsApi({ transport, queryClient: new QueryClient(), account: port, port, marketplace })!
    const answer = await api.backendFetch("counter", "/count", { method: "POST", body: JSON.stringify({ by: 1 }) })
    expect([answer.status, await answer.json()]).toEqual([201, { value: 2 }])
    expect(runs).toEqual([["plugin.request", { pluginId: "counter", method: "POST", path: "/count", body: { by: 1 } }]])
    await expect(api.backendFetch("counter", "/count", { method: "POST", body: "[1]" })).rejects.toMatchObject({ class: "invalid" })
  })

  test("on a signed desktop, reads a bundle's bytes out of main's base64 envelope", async () => {
    const { port } = bridge({ bytesBase64: btoa("export default {}") })
    const api = createAppPluginsApi({ transport, queryClient: new QueryClient(), account: port, port, marketplace })!
    expect(new TextDecoder().decode(await api.bundle("counter", "a".repeat(64)))).toBe("export default {}")
  })
})

describe("an app plugin's agent tools switch", () => {
  test("writes the plugin's own activation subject for every harness at the catalog revision, then rereads the installs", async () => {
    const { port: account } = bridge(undefined)
    const queryClient = new QueryClient()
    const installs = queryKeys.appPluginsInstalled(transport.serverUrl)
    queryClient.setQueryData(installs, [])
    const api = createAppPluginsApi({ transport, queryClient, account, port: undefined, marketplace })!
    activations.splice(0)
    await api.setTools({ pluginId: "notes", on: false, revision: 7, harnessIds: ["opencode", "claude"] })
    expect(activations).toEqual([{ pluginInstanceId: "app-plugin:notes", harnessIds: ["opencode", "claude"], choice: false, revision: 7 }])
    expect(queryClient.getQueryState(installs)?.isInvalidated).toBe(true)
  })

  test("reads the tools an install declares and whether they are on for the member", async () => {
    const manifest = { id: "notes", name: "Notes", version: "0.1.0", app: "./src/app.js" }
    const row = { id: "notes", version: "0.1.0", manifest, app: { sha256: "a".repeat(64) }, active: true, enabledForMe: true, orgDefault: false }
    const [declared] = await appPluginInstallsFromWire([{ ...row, tools: { label: "Notes", names: ["note_list"], on: false } }])
    expect(declared?.tools).toEqual({ label: "Notes", names: ["note_list"], on: false })
    expect((await appPluginInstallsFromWire([row]))[0]?.tools).toBeUndefined()
    await expect(appPluginInstallsFromWire([{ ...row, tools: { label: "Notes", names: "note_list", on: false } }])).rejects.toMatchObject({ class: "internal" })
  })
})

describe("the enabled app plugin list", () => {
  test("refuses a row whose bundle is not named by a full SHA-256", async () => {
    const manifest = { id: "counter", name: "Counter", version: "0.1.0", app: "./src/app.js" }
    expect((await enabledAppPluginsFromWire([{ id: "counter", version: "0.1.0", manifest, app: { sha256: "a".repeat(64) } }]))[0]?.appSha256).toBe("a".repeat(64))
    await expect(enabledAppPluginsFromWire([{ id: "counter", version: "0.1.0", manifest, app: { sha256: "a".repeat(16) } }])).rejects.toMatchObject({ class: "internal" })
  })
})
