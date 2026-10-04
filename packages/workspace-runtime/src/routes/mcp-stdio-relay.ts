import { Hono } from "hono"
import type { UpgradeWebSocket, WSContext } from "hono/ws"
import { errorBody } from "@claxedo/session-core"
import type { HarnessServices, PluginProjection, ProjectedMcpServer } from "@claxedo/harness/contract"
import { mcpStdioBaseEnv, OwnedStdioMcpTransport, parseMcpMessage } from "@claxedo/harness/pi-durable/mcp-stdio"
import { Log } from "../log"

type StdioServer = Extract<ProjectedMcpServer, { kind: "stdio" }>
type McpMessage = ReturnType<typeof parseMcpMessage>
type HeartbeatSocket = { ping(): void; terminate(): void; on(event: "pong", listener: () => void): unknown }

export type McpStdioRelayOptions = {
  directory: string
  env: NodeJS.ProcessEnv
  services: Pick<HarnessServices, "spawn" | "clock">
  piProjection: () => PluginProjection
  upgradeWebSocket: UpgradeWebSocket
  heartbeatMs?: number
}

type Env = { Variables: { executionSessionId: string; mcpServer: StdioServer } }

const MAX_PENDING_MESSAGES = 64
const HEARTBEAT_MS = 30_000
const log = Log.create({ service: "mcp-stdio-relay" })

function pluginStdioServer(projection: PluginProjection, name: string): StdioServer | undefined {
  return projection.mcpServers.find((server): server is StdioServer & { origin: "plugin" } =>
    server.name === name && server.kind === "stdio" && server.origin === "plugin")
}

function isHeartbeatSocket(raw: unknown): raw is HeartbeatSocket {
  return typeof raw === "object" && raw !== null && "ping" in raw && typeof raw.ping === "function"
    && "terminate" in raw && typeof raw.terminate === "function" && "on" in raw && typeof raw.on === "function"
}

function heartbeat(socket: HeartbeatSocket, ms: number) {
  let answered = true
  socket.on("pong", () => { answered = true })
  return setInterval(() => {
    if (!answered) return socket.terminate()
    answered = false
    socket.ping()
  }, ms)
}

export function McpStdioRelayRoutes(options: McpStdioRelayOptions) {
  const open = new Set<OwnedStdioMcpTransport>()
  const baseEnv = mcpStdioBaseEnv(options.env)
  const close = (transport: OwnedStdioMcpTransport) => {
    open.delete(transport)
    return transport.close().catch((error: unknown) => log.warn("MCP server did not stop", { error: String(error) }))
  }
  const routes = new Hono<Env>().get("/:serverName", async (c, next) => {
    const server = pluginStdioServer(options.piProjection(), c.req.param("serverName"))
    if (!server) return c.json(errorBody("mcp_server_not_found", "No plugin stdio MCP server has that name"), 404)
    c.set("mcpServer", server)
    return next()
  }, options.upgradeWebSocket((c) => {
    const transport = new OwnedStdioMcpTransport(c.get("mcpServer"),
      { cwd: options.directory, sessionId: c.get("executionSessionId"), baseEnv, services: options.services })
    const pending: McpMessage[] = []
    let state: "starting" | "running" | "closed" = "starting"
    let beat: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      state = "closed"
      clearInterval(beat)
      void close(transport)
    }
    const forward = (message: McpMessage, ws: WSContext) =>
      void transport.send(message).catch(() => ws.close(1011, "mcp_server_unwritable"))
    return {
      async onOpen(_event, ws) {
        if (!isHeartbeatSocket(ws.raw)) return ws.close(1011, "mcp_socket_unsupported")
        beat = heartbeat(ws.raw, options.heartbeatMs ?? HEARTBEAT_MS)
        open.add(transport)
        transport.onMessage((message) => ws.send(JSON.stringify(message)))
        transport.onError(() => ws.close(1011, "mcp_server_invalid_output"))
        transport.onClose(() => ws.close(1011, "mcp_server_exited"))
        try {
          await transport.start()
        } catch {
          return ws.close(1011, "mcp_server_spawn_failed")
        }
        if (state === "closed") return void close(transport)
        state = "running"
        for (const message of pending.splice(0)) forward(message, ws)
      },
      onMessage(event, ws) {
        let message: McpMessage
        try {
          message = parseMcpMessage(typeof event.data === "string" ? event.data : "")
        } catch {
          return ws.close(1007, "mcp_message_invalid")
        }
        if (state === "running") return forward(message, ws)
        if (pending.length >= MAX_PENDING_MESSAGES) return ws.close(1008, "mcp_pending_overflow")
        pending.push(message)
      },
      onClose: stop,
      onError: stop,
    }
  }))
  return { routes, dispose: async () => { await Promise.all([...open].map(close)) } }
}
