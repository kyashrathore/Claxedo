import { parseJsonRpcMessage, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp"
import type { TurnExecutionAccess } from "@claxedo/harness/contract"

/**
 * A plugin's stdio MCP server, run by the workspace machine from its own
 * materialized plugins and reached by name over one WebSocket through the
 * relay. Each frame is one JSON-RPC message; the server never sees a command
 * from here.
 */
export class RelayedStdioMcpTransport implements McpTransport {
  private socket: WebSocket | undefined
  private readonly messages = new Set<(message: JsonRpcMessage) => void>()
  private readonly errors = new Set<(error: Error) => void>()
  private readonly closes = new Set<() => void>()

  constructor(private readonly serverName: string, private readonly access: () => Promise<TurnExecutionAccess>) {}

  async start(): Promise<void> {
    const access = await this.access()
    const url = `${access.relayUrl}/workspaces/${encodeURIComponent(access.workspaceId)}/api/wr/execution-env/mcp/${encodeURIComponent(this.serverName)}`
    const response = await fetch(url, { headers: { upgrade: "websocket", authorization: `Bearer ${access.runtimeAccessToken}` } })
    const socket = response.webSocket
    if (!socket) throw new Error(`MCP server ${this.serverName} was not opened on the workspace machine: ${response.status} ${await response.text()}`)
    socket.accept()
    socket.addEventListener("message", (event) => this.receive(event.data))
    socket.addEventListener("close", () => { for (const listener of this.closes) listener() })
    socket.addEventListener("error", () => { for (const listener of this.errors) listener(new Error(`MCP server ${this.serverName}'s socket failed`)) })
    this.socket = socket
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(`MCP server ${this.serverName} is not connected`)
    this.socket.send(JSON.stringify(message))
  }

  async close(): Promise<void> {
    this.socket?.close(1000, "closed")
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener) }

  onError(listener: (error: Error) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener) }

  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener) }

  private receive(data: unknown): void {
    try {
      const message = parseJsonRpcMessage(JSON.parse(String(data)))
      for (const listener of this.messages) listener(message)
    } catch (error) {
      for (const listener of this.errors) listener(new Error(`MCP server ${this.serverName} sent an invalid message: ${String(error)}`))
    }
  }
}
