import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import type { OpenCodeHost } from "./host"
import { createToolPort } from "./tool-port"

const servers: Array<ReturnType<typeof Bun.serve>> = []

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
    async plugin(plugin: Plugin.Plugin) {
      await plugin.setup({ tool } as never)
    },
  }
  const host = { client: async () => client } as unknown as OpenCodeHost
  const port = createToolPort(host)

  await port.registerSession({
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
