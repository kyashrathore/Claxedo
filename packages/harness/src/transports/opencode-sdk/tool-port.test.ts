import { expect, test } from "bun:test"
import os from "node:os"
import { createToolPort } from "./tool-port"
import { WorkspaceScope } from "./scope"

test("tool catalogs stay location-scoped and reload every instance of the directory", async () => {
  const catalogs = new Map<string, string[][]>()
  const port = createToolPort()
  const instance = async (directory: string, slot: number) => {
    let transform: (draft: { add(tool: { name: string }): void }) => unknown
    await port.plugin.setup({ location: { directory }, session: { hook: async () => ({}) }, tool: {
      transform(callback: typeof transform) { transform = callback },
      async reload() {
        const names: string[] = []
        await transform({ add: (tool) => names.push(tool.name) })
        const rows = catalogs.get(directory) ?? []
        rows[slot] = names
        catalogs.set(directory, rows)
      },
    } } as never)
  }
  const alpha = WorkspaceScope.authorize({ workspaceID: "alpha", directory: process.cwd() })
  const beta = WorkspaceScope.authorize({ workspaceID: "beta", directory: os.tmpdir() })
  await instance(alpha.directory, 0)
  await instance(alpha.directory, 1)
  await instance(beta.directory, 0)
  const registration = (sessionID: string, scope: typeof alpha, name: string) => ({
    sessionID, scope, execute: async () => ({ ok: true }),
    tools: [{ name, description: name, inputSchema: { type: "object" } }],
  })
  await port.registerSession(registration("a", alpha, "alpha_tool"))
  await port.registerSession(registration("b", beta, "beta_tool"))
  expect(catalogs.get(alpha.directory)).toEqual([["alpha_tool"], ["alpha_tool"]])
  expect(catalogs.get(beta.directory)).toEqual([["beta_tool"]])
  await expect(port.registerSession(registration("a", beta, "leak"))).rejects.toThrow("another workspace")
  await port.unregisterSession("a")
  expect(catalogs.get(alpha.directory)).toEqual([[], []])
  expect(catalogs.get(beta.directory)).toEqual([["beta_tool"]])
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
  const port = createToolPort()
  await port.plugin.setup({ tool, session: { hook: async () => ({}) }, location: { directory: process.cwd() } } as never)

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

test("a session's model catalog lists only the Claxedo tools registered for it, and leaves the engine's own", async () => {
  type Catalog = { sessionID: string; tools: Record<string, unknown> }
  let filter: ((input: Catalog) => void) | undefined
  let transform: ((draft: { add(definition: unknown): void }) => void | Promise<void>) | undefined
  const tool = { transform(callback: typeof transform) { transform = callback }, async reload() { await transform?.({ add() {} }) } }
  const session = { async hook(name: string, callback: (input: Catalog) => void) {
    if (name === "context") filter = callback
    return {}
  } }
  const port = createToolPort()
  await port.plugin.setup({ tool, session, location: { directory: process.cwd() } } as never)
  const scope = WorkspaceScope.authorize({ workspaceID: "test", directory: process.cwd() })
  const definition = (name: string) => ({ name, description: name, inputSchema: { type: "object" } })
  await port.registerSession({ scope, sessionID: "owner", tools: [definition("app_plugin_guide"), definition("sessions_list")], execute: async () => ({}) })
  await port.registerSession({ scope, sessionID: "member", tools: [definition("sessions_list")], execute: async () => ({}) })

  const member: Catalog = { sessionID: "member", tools: { app_plugin_guide: {}, sessions_list: {}, read: {} } }
  filter!(member)
  expect(member.tools).toEqual({ sessions_list: {}, read: {} })
  const owner: Catalog = { sessionID: "owner", tools: { app_plugin_guide: {}, sessions_list: {}, read: {} } }
  filter!(owner)
  expect(owner.tools).toEqual({ app_plugin_guide: {}, sessions_list: {}, read: {} })
  const stranger: Catalog = { sessionID: "stranger", tools: { app_plugin_guide: {}, sessions_list: {}, read: {} } }
  filter!(stranger)
  expect(stranger.tools).toEqual({ read: {} })
})
