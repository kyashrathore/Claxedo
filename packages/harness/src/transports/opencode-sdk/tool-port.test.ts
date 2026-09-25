import { expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import type { OpenCodeHost } from "./host"
import { createToolPort } from "./tool-port"
import { WorkspaceScope } from "./scope"

test("tool catalogs stay location-scoped and a failed plugin install can retry", async () => {
  let installed: Plugin.Plugin | undefined
  let attempts = 0
  const catalogs = new Map<string, string[]>()
  const setups = new Set<string>()
  const plugin = Object.assign(
    async (next: Plugin.Plugin) => {
      if (++attempts === 1) throw new Error("boot failed")
      installed = next
    },
    { async awaitActivation({ location }: { location: { directory: string } }) {
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
    } },
  )
  const client = { plugin }
  const port = createToolPort({ client: async () => client } as unknown as OpenCodeHost)
  const alpha = WorkspaceScope.authorize({ workspaceID: "alpha", directory: process.cwd() })
  const beta = WorkspaceScope.authorize({ workspaceID: "beta", directory: "/tmp" })
  const registration = (sessionID: string, scope: typeof alpha, name: string) => ({
    sessionID, scope, execute: async () => ({ ok: true }),
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

test("same-directory sessions dispatch by engine session and refuse forged identity", async () => {
  const calls: Array<{ session: string; name: string; input: unknown }> = []

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
  const plugin = Object.assign(
    async (next: Plugin.Plugin) => { await next.setup({ tool, location: { directory: process.cwd() } } as never) },
    { async awaitActivation() {} },
  )
  const client = { plugin }
  const host = { client: async () => client } as unknown as OpenCodeHost
  const port = createToolPort(host)

  const scope = WorkspaceScope.authorize({ workspaceID: "test", directory: process.cwd() })
  for (const sessionID of ["session-1", "session-2"]) {
    await port.registerSession({ scope, sessionID,
      tools: [{ name: "workgraph_run", description: "Run operation", inputSchema: { type: "object" } }],
      execute: async (call) => { calls.push({ session: sessionID, name: call.name, input: call.input }); return { ok: true } },
    })
  }
  const definition = definitions.get("workgraph_run")!
  await definition.execute({ command: "claim" }, { sessionID: "session-1", id: "call-1" })
  await definition.execute({ command: "read" }, { sessionID: "session-2", id: "call-2" })
  await expect(definition.execute({ command: "forge" }, { sessionID: "forged", id: "call-3" })).rejects.toThrow("not registered")
  expect(calls).toEqual([
    { session: "session-1", name: "workgraph_run", input: { command: "claim" } },
    { session: "session-2", name: "workgraph_run", input: { command: "read" } },
  ])
})
