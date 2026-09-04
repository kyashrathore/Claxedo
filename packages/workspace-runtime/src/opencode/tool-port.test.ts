import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import type { OpenCodeHost } from "./host"
import { createToolPort } from "./tool-port"
import { authorizeWorkspace } from "./scope"

const servers: Array<ReturnType<typeof Bun.serve>> = []

test("tool catalogs stay location-scoped and a failed plugin install can retry", async () => {
  let installed: Plugin.Plugin | undefined
  let attempts = 0
  const catalogs = new Map<string, string[]>()
  const setups = new Set<string>()
  const client = {
    async plugin(plugin: Plugin.Plugin) {
      if (++attempts === 1) throw new Error("boot failed")
      installed = plugin
    },
    model: { async list({ location }: { location: { directory: string } }) {
      const directory = location.directory
      if (!setups.has(directory)) {
        let transform: (draft: { add(tool: { name: string }): void }) => unknown
        await installed!.setup({ location, tool: {
          transform(callback: typeof transform) { transform = callback },
          async reload() {
            const names: string[] = []
            await transform({ add: (tool) => names.push(tool.name) })
            catalogs.set(directory, names)
          },
        } } as never)
        setups.add(directory)
      }
      return { data: [] }
    } },
  }
  const port = createToolPort({ client: async () => client } as unknown as OpenCodeHost)
  const alpha = authorizeWorkspace({ workspaceID: "alpha", directory: process.cwd() })
  const beta = authorizeWorkspace({ workspaceID: "beta", directory: "/tmp" })
  const registration = (sessionID: string, scope: typeof alpha, name: string) => ({
    sessionID, scope, callbackUrl: "http://localhost/callback",
    tools: [{ name, description: name, inputSchema: { type: "object" } }],
  })
  await expect(port.registerSession(registration("a", alpha, "alpha_tool"))).rejects.toThrow("boot failed")
  await port.registerSession(registration("a", alpha, "alpha_tool"))
  await port.registerSession(registration("b", beta, "beta_tool"))
  expect(attempts).toBe(2)
  expect(catalogs.get(alpha.directory)).toEqual(["alpha_tool"])
  expect(catalogs.get(beta.directory)).toEqual(["beta_tool"])
  await expect(port.registerSession(registration("a", beta, "leak"))).rejects.toThrow("another workspace")
  await port.unregisterSession("a")
  expect(catalogs.get(alpha.directory)).toEqual([])
  expect(catalogs.get(beta.directory)).toEqual(["beta_tool"])
})

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

test("merged Session tool groups keep their authoritative callback", async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls.push({ path: new URL(request.url).pathname, body: await request.json() })
      return Response.json({ ok: true })
    },
  })
  servers.push(server)

  let transform: ((draft: { add(definition: unknown): void }) => void | Promise<void>) | undefined
  const definitions = new Map<string, {
    execute(input: unknown, context: { sessionID: unknown; id: unknown }): Promise<unknown>
  }>()
  const tool = {
    transform(callback: typeof transform) {
      transform = callback
    },
    async reload() {
      definitions.clear()
      await transform?.({
        add(value) {
          const definition = value as { name: string; execute: (input: unknown, context: { sessionID: unknown; id: unknown }) => Promise<unknown> }
          definitions.set(definition.name, definition)
        },
      })
    },
  }
  const client = {
    model: { list: async () => ({ data: [] }) },
    async plugin(plugin: Plugin.Plugin) {
      await plugin.setup({ tool, location: { directory: process.cwd() } } as never)
    },
  }
  const host = { client: async () => client } as unknown as OpenCodeHost
  const port = createToolPort(host)

  await port.registerSession({
    scope: authorizeWorkspace({ workspaceID: "test", directory: process.cwd() }),
    sessionID: "session-1",
    callbackUrl: `${server.url}default`,
    tools: [
      {
        name: "workgraph_run",
        description: "Run operation",
        inputSchema: { type: "object" },
        callbackUrl: `${server.url}run`,
      },
      {
        name: "workgraph_connection",
        description: "Connection operation",
        inputSchema: { type: "object" },
        callbackUrl: `${server.url}connection`,
      },
    ],
  })

  await definitions.get("workgraph_run")?.execute({ command: "claim" }, { sessionID: "session-1", id: "call-1" })
  await definitions.get("workgraph_connection")?.execute({ command: "read" }, { sessionID: "session-1", id: "call-2" })

  expect(calls.map((call) => call.path)).toEqual(["/run", "/connection"])
  expect(calls.map((call) => call.body)).toEqual([
    { sessionID: "session-1", name: "workgraph_run", toolCallID: "call-1", input: { command: "claim" } },
    { sessionID: "session-1", name: "workgraph_connection", toolCallID: "call-2", input: { command: "read" } },
  ])
})
