import type { SessionLocation } from "./types"

export type McpAppTool = {
  readonly name: string
  readonly readOnly: boolean
  readonly visibleToApp: boolean
}

export type McpProtocolResult = Readonly<Record<string, unknown>>

export type McpAppsApi = {
  readonly mcpTools: (ref: SessionLocation, server: string) => Promise<readonly McpAppTool[]>
  readonly callMcpTool: (ref: SessionLocation, server: string, tool: string, args: Readonly<Record<string, unknown>>) => Promise<McpProtocolResult>
  readonly readMcpResource: (ref: SessionLocation, server: string, uri: string) => Promise<McpProtocolResult>
}
