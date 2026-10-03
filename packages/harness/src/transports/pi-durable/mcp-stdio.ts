import { errorMessage } from "@claxedo/helpers"
import { parseJsonRpcMessage, type JsonRpcMessage, type McpTransport } from "@earendil-works/pi-mcp"
import { deadlineAfter, type HarnessServices, type OwnedProcess, type ProjectedMcpServer } from "../../contract/node"

type StdioServer = Extract<ProjectedMcpServer, { kind: "stdio" }>

export class OwnedStdioMcpTransport implements McpTransport {
  private owned: OwnedProcess | undefined
  private buffer = ""
  private readonly messages = new Set<(message: JsonRpcMessage) => void>()
  private readonly errors = new Set<(error: Error) => void>()
  private readonly closes = new Set<() => void>()

  constructor(private readonly server: StdioServer, private readonly host: { cwd: string; sessionId: string; baseEnv: Readonly<Record<string, string>>;
    services: HarnessServices }) {}

  async start(): Promise<void> {
    const owned = await this.host.services.spawn({ file: this.server.command, args: [...this.server.args ?? []],
      cwd: this.server.cwd ?? this.host.cwd, env: { ...this.host.baseEnv, ...this.server.env } },
    { role: "harness", label: `Pi MCP ${this.server.name}`, sessionId: this.host.sessionId, signal: new AbortController().signal })
    this.owned = owned
    owned.stdout.setEncoding("utf8")
    owned.stdout.on("data", (chunk: string) => this.read(chunk))
    void owned.exited.then(() => { for (const listener of this.closes) listener() })
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.owned?.stdin
    if (!stdin?.writable) throw new Error(`MCP server ${this.server.name} is not running`)
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve()))
  }

  async close(): Promise<void> {
    const result = await this.owned?.retire(deadlineAfter(this.host.services.clock, 5_000))
    if (result && !result.stopped) throw new Error(`MCP server ${this.server.name} did not stop: ${result.error.message}`)
  }

  onMessage(listener: (message: JsonRpcMessage) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener) }

  onError(listener: (error: Error) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener) }

  onClose(listener: () => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener) }

  private read(chunk: string): void {
    this.buffer += chunk
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.deliver(line)
    }
  }

  private deliver(line: string): void {
    try {
      const message = parseJsonRpcMessage(JSON.parse(line))
      for (const listener of this.messages) listener(message)
    } catch (error) {
      const failure = new Error(`MCP server ${this.server.name} wrote an invalid message: ${errorMessage(error)}`)
      for (const listener of this.errors) listener(failure)
    }
  }
}
