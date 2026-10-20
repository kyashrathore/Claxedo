import { ServerError } from "./errors"
import type { McpAppsApi } from "./mcp-app-types"
import { onRuntime, sessionEndpoint, type SessionContext } from "./session-context"
import { jsonInit, type RuntimeRoute } from "./transport"
import type { SessionLocation } from "./types"
import { mcpAppToolsFromWire, mcpResourceReadFromWire, mcpToolCallFromWire } from "./wire/mcp-apps"

function mcpEndpoint(ref: SessionLocation, server: string, operation: "tools" | "tool-call" | "resource-read") {
  return sessionEndpoint(ref, `/mcp/${encodeURIComponent(server)}/${operation}`)
}

function runtimeAsleep(): never {
  throw new ServerError({ class: "runtime_unreachable", message: "The session's runtime is not running", code: "runtime_asleep", retryable: false })
}

function onLiveRuntime<T>(context: SessionContext, ref: SessionLocation, live: (route: RuntimeRoute) => Promise<T>): Promise<T> {
  return onRuntime(context, ref, live, async () => runtimeAsleep())
}

export function createMcpAppsApi(context: SessionContext): McpAppsApi {
  const { transport } = context
  return {
    mcpTools: (ref, server) =>
      onLiveRuntime(context, ref, async (route) => mcpAppToolsFromWire(await transport.runtimeJson(route, mcpEndpoint(ref, server, "tools")))),
    callMcpTool: (ref, server, tool, args) =>
      onLiveRuntime(context, ref, async (route) =>
        mcpToolCallFromWire(await transport.runtimeJson(route, mcpEndpoint(ref, server, "tool-call"), jsonInit("POST", { tool, arguments: args })))),
    readMcpResource: (ref, server, uri) =>
      onLiveRuntime(context, ref, async (route) =>
        mcpResourceReadFromWire(await transport.runtimeJson(route, mcpEndpoint(ref, server, "resource-read"), jsonInit("POST", { uri })))),
  }
}
