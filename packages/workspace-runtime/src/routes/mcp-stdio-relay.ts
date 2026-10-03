import { Hono } from "hono"
import type { UpgradeWebSocket, WSContext } from "hono/ws"
import { errorBody } from "@claxedo/session-core"
import type { HarnessServices, OwnedProcess, PluginProjection, ProjectedMcpServer } from "@claxedo/harness/contract"
import { spawnEnv } from "./owned-shell"

type StdioServer = Extract<ProjectedMcpServer, { kind: "stdio" }>

export type McpStdioRelayOptions = {
  directory: string
  env: NodeJS.ProcessEnv
  spawn: HarnessServices["spawn"]
  piProjection: () => PluginProjection
  upgradeWebSocket: UpgradeWebSocket
}

type Env = { Variables: { executionSessionId: string; mcpServer: StdioServer } }

const RETIRE_MS = 5_000

function pluginStdioServer(projection: PluginProjection, name: string): StdioServer | undefined {
  return projection.mcpServers.find((server): server is StdioServer & { origin: "plugin" } =>
    server.name === name && server.kind === "stdio" && server.origin === "plugin")
}

function singleLine(data: unknown): string | undefined {
  try {
    return JSON.stringify(JSON.parse(String(data)))
  } catch {
    return undefined
  }
}

function bridge(owned: OwnedProcess, ws: WSContext) {
  let buffer = ""
  owned.stderr.resume()
  owned.stdout.setEncoding("utf8")
  owned.stdout.on("data", (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) ws.send(line)
    }
  })
  void owned.exited.then(() => ws.close(1011, "mcp_server_exited"))
}

export function McpStdioRelayRoutes(options: McpStdioRelayOptions) {
  return new Hono<Env>().get("/:serverName", async (c, next) => {
    const server = pluginStdioServer(options.piProjection(), c.req.param("serverName"))
    if (!server) return c.json(errorBody("mcp_server_not_found", "No plugin stdio MCP server has that name"), 404)
    c.set("mcpServer", server)
    return next()
  }, options.upgradeWebSocket((c) => {
    const server = c.get("mcpServer")
    const closed = new AbortController()
    const pending: string[] = []
    let owned: OwnedProcess | undefined
    const retire = () => owned?.retire({ at: Date.now() + RETIRE_MS, signal: new AbortController().signal })
    return {
      async onOpen(_event, ws) {
        try {
          owned = await options.spawn({ file: server.command, args: [...server.args ?? []], cwd: server.cwd ?? options.directory,
            env: spawnEnv(options.env, server.env) },
          { role: "harness", label: `Pi MCP ${server.name}`, sessionId: c.get("executionSessionId"), signal: closed.signal })
        } catch {
          ws.close(1011, "mcp_server_spawn_failed")
          return
        }
        if (closed.signal.aborted) {
          void retire()
          return
        }
        bridge(owned, ws)
        for (const line of pending.splice(0)) owned.stdin.write(`${line}\n`)
      },
      onMessage(event, ws) {
        const line = singleLine(event.data)
        if (line === undefined) return ws.close(1007, "mcp_message_invalid")
        if (owned) owned.stdin.write(`${line}\n`)
        else pending.push(line)
      },
      onClose() {
        closed.abort()
        void retire()
      },
    }
  }))
}
