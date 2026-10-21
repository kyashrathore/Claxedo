import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  ListToolsRequestSchema,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js"
import type { ClaxedoMcpClient } from "../client/contract"
import type { McpAuditEvent, McpCredential, McpToolContext } from "../context"
import type { McpToolGroup } from "../tools/index"
import { createToolRegistry, type ToolRegistrar } from "../tools/registry"

export type McpSession = {
  transport: WebStandardStreamableHTTPServerTransport
  close: () => Promise<void>
}

export type McpSessionInput = Readonly<{
  serverInfo: Readonly<{ name: string; version: string }>
  credential: McpCredential
  client: ClaxedoMcpClient
  audit: (event: McpAuditEvent) => void | Promise<void>
  groups: ReadonlyArray<McpToolGroup>
  /** Registered after `groups`; a tool whose name is already registered is left out, so a plugin can never replace a tool. */
  pluginGroups?: ReadonlyArray<McpToolGroup>
  /** Absent, each request is its own exchange answered as JSON; present, the transport keeps a session under the id it mints. */
  stateful?: Readonly<{
    onInitialized: (id: string, session: McpSession) => void
    onClosed: (id: string) => void
  }>
}>

/** An MCP server with the caller's tool groups registered, connected to a streamable-HTTP transport. */
export async function startMcpSession(input: McpSessionInput): Promise<McpSession> {
  const server = new McpServer(input.serverInfo)
  const inFlightCalls = new Set<RequestId>()
  const elicit = (params: ElicitRequestFormParams | ElicitRequestURLParams) => {
    const [only] = inFlightCalls
    return server.server.elicitInput(params, inFlightCalls.size === 1 && only !== undefined ? { relatedRequestId: only } : undefined)
  }
  const ctx: McpToolContext = {
    credential: input.credential,
    client: input.client,
    audit: input.audit,
    // Known only once `initialize` has been handled, which is after this
    // context is built and after every tool is registered against it.
    get elicit() {
      return server.server.getClientCapabilities()?.elicitation ? elicit : undefined
    },
  }
  const registry = createToolRegistry(server, ctx)
  for (const group of input.groups) group.register(registry)
  const unclaimed: ToolRegistrar = {
    tool: (name, definition, handler) => {
      if (!registry.declared.has(name)) registry.tool(name, definition, handler)
    },
  }
  for (const group of input.pluginGroups ?? []) group.register(unclaimed)
  if (registry.listed.length === 0) {
    server.server.registerCapabilities({ tools: {} })
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
  }
  const { stateful } = input
  const session: McpSession = {
    transport: new WebStandardStreamableHTTPServerTransport(stateful
      ? {
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => stateful.onInitialized(id, session),
          onsessionclosed: (id) => stateful.onClosed(id),
        }
      : { sessionIdGenerator: undefined, enableJsonResponse: true }),
    close: () => session.transport.close(),
  }
  await server.connect(session.transport)
  // A server-initiated request rides the SSE stream of the tool call that
  // made it whenever exactly one call is open; the SDK otherwise routes it
  // to the standalone GET stream, which not every host opens.
  const { transport } = session
  const onmessage = transport.onmessage
  transport.onmessage = (message, extra) => {
    registry.refresh()
    if (isJSONRPCRequest(message) && message.method === "tools/call") inFlightCalls.add(message.id)
    onmessage?.(message, extra)
  }
  const send = transport.send.bind(transport)
  transport.send = async (message, sendOptions) => {
    try {
      await send(message, sendOptions)
    } finally {
      if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id != null) {
        inFlightCalls.delete(message.id)
      }
    }
  }
  return session
}
