import type { McpAppsApi, McpAppTool, McpProtocolResult, SessionLocation } from "@/server"

export type AppServerCalls = {
  readonly tools: () => Promise<readonly McpAppTool[]>
  readonly callTool: (tool: string, args: Readonly<Record<string, unknown>>) => Promise<McpProtocolResult>
  readonly readResource: (uri: string) => Promise<McpProtocolResult>
}

export function appServerCalls(api: McpAppsApi, ref: SessionLocation, server: string): AppServerCalls {
  return {
    tools: () => api.mcpTools(ref, server),
    callTool: (tool, args) => api.callMcpTool(ref, server, tool, args),
    readResource: (uri) => api.readMcpResource(ref, server, uri),
  }
}
