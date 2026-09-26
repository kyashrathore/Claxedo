import type { FirstPartyMcpServer } from "./first-party-mcp"

export type FirstPartyTool = { name: string; description?: string; inputSchema: Record<string, unknown> }
export type FirstPartyToolResult = { content: Array<Record<string, unknown>>; isError?: boolean }

// Self-contained so the Pi extension runs the same transport in its own process.
export async function connectFirstPartyMcp(server: FirstPartyMcpServer) {
  let session: string | null = null
  let sequence = 0
  let version = "2025-03-26"
  const transport = {
    headers() {
      return {
        ...server.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": version,
        ...(session ? { "mcp-session-id": session } : {}),
      }
    },
    result(
      body: { id?: unknown; result?: Record<string, unknown>; error?: { message: string } },
      id: number,
      method: string,
    ) {
      if (body.id !== id) return undefined
      if (body.error) throw new Error(body.error.message)
      if (!body.result) throw new Error(`Claxedo MCP ${method} returned no result`)
      return body.result
    },
    async request(
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> {
      const id = ++sequence
      const response = await fetch(server.url, {
        method: "POST",
        headers: transport.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error(`Claxedo MCP ${method} failed (${response.status})`)
      session = response.headers.get("mcp-session-id") ?? session
      if (response.headers.get("content-type")?.includes("application/json")) {
        const result = transport.result(await response.json(), id, method)
        if (!result) throw new Error("Claxedo MCP response identity mismatch")
        return result
      }
      if (!response.body) throw new Error("Claxedo MCP returned no stream")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const chunk = await reader.read()
          buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replace(/\r\n/g, "\n")
          let end: number
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            if (!data) continue
            const result = transport.result(JSON.parse(data), id, method)
            if (result) return result
          }
          if (chunk.done) throw new Error(`Claxedo MCP ${method} stream ended without a response`)
        }
      } finally {
        await reader.cancel()
      }
    },
  }
  const initialized = await transport.request("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "claxedo-harness", version: "1" },
  })
  version = String(initialized.protocolVersion)
  const notification = await fetch(server.url, {
    method: "POST",
    headers: transport.headers(),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(10_000),
  })
  await notification.body?.cancel()
  if (!notification.ok) throw new Error(`Claxedo MCP initialization failed (${notification.status})`)
  return {
    async tools(): Promise<FirstPartyTool[]> {
      const tools: FirstPartyTool[] = []
      let cursor: string | undefined
      do {
        const page = await transport.request("tools/list", cursor ? { cursor } : {})
        tools.push(...(page.tools as FirstPartyTool[]))
        cursor = page.nextCursor as string | undefined
      } while (cursor)
      return tools
    },
    async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<FirstPartyToolResult> {
      return (await transport.request("tools/call", { name, arguments: args }, signal)) as FirstPartyToolResult
    },
    async close() {
      if (!session) return
      const response = await fetch(server.url, {
        method: "DELETE",
        headers: transport.headers(),
        signal: AbortSignal.timeout(10_000),
      })
      await response.body?.cancel()
      if (!response.ok && response.status !== 404) throw new Error(`Claxedo MCP close failed (${response.status})`)
      session = null
    },
  }
}
