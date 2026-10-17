import type { McpOperationRefusal } from "@claxedo/harness/contract"
import { asRecord, asString } from "@claxedo/helpers/guards"
import { routeParam } from "@claxedo/helpers/route-param"
import type { SessionAccessOperation } from "../session-access-policy"
import type { SessionMcpUnsupported } from "../host/mcp"
import type { AgentRuntime } from "../host/runtime"
import { errorBody } from "./error-body"
import { boundedJsonRecord, noStoreJson } from "./http"
import { unsupportedOperation } from "./session-harness-refusal"
import { sessionOperationGuard } from "./session-operation-guard"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

type McpRouteInput = { c: Ctx; runtime: AgentRuntime; sessionId: string; server: string; directory?: string }

const REFUSAL_STATUS = { not_found: 404, refused: 403, unavailable: 502 } as const

function mcpRoute<T>(opts: Opts, operation: SessionAccessOperation,
  run: (input: McpRouteInput) => Promise<Response | { ok: true; body: T } | McpOperationRefusal | SessionMcpUnsupported>) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, operation)
    if (guarded) return guarded
    const directory = await opts.resolveDirectory(c, { sessionId })
    const answered = await run({ c, runtime: await opts.runtime(c), sessionId, server: routeParam(c, "server"), ...(directory ? { directory } : {}) })
    if (answered instanceof Response) return answered
    if (answered.ok) return noStoreJson(c, answered.body)
    if (answered.status === "unsupported") return unsupportedOperation(c, answered.harness, operation, { capability: "mcp" })
    return noStoreJson(c, answered, REFUSAL_STATUS[answered.status])
  }
}

export function mcpToolsRoute(opts: Opts) {
  return mcpRoute(opts, "mcp_tools_list", async ({ runtime, sessionId, server, directory }) => {
    const listed = await runtime.mcp.listTools(sessionId, server, directory)
    return listed.ok ? { ok: true, body: { tools: listed.tools } } : listed
  })
}

export function mcpToolCallRoute(opts: Opts) {
  return mcpRoute(opts, "mcp_tool_call", async ({ c, runtime, sessionId, server, directory }) => {
    const body = await boundedJsonRecord(c)
    const tool = asString(body.tool)
    const args = body.arguments === undefined ? {} : asRecord(body.arguments)
    if (!tool || !args) return noStoreJson(c, errorBody("invalid_request", "A tool call names its tool and passes its arguments as an object"), 400)
    const called = await runtime.mcp.callTool(sessionId, { server, tool, arguments: args }, directory)
    return called.ok ? { ok: true, body: called.result } : called
  })
}

export function mcpResourceReadRoute(opts: Opts) {
  return mcpRoute(opts, "mcp_resource_read", async ({ c, runtime, sessionId, server, directory }) => {
    const uri = asString((await boundedJsonRecord(c)).uri)
    if (!uri) return noStoreJson(c, errorBody("invalid_request", "A resource read names its uri"), 400)
    const read = await runtime.mcp.readResource(sessionId, { server, uri }, directory)
    return read.ok ? { ok: true, body: read.result } : read
  })
}
