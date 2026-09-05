import { Hono } from "hono"
import { forwardMcpGatewayRequest, McpGatewayError } from "@claxedo/server-core/agent-plugins/mcp/gateway"
import { McpGatewayConfigurationError, verifyMcpGatewayToken, type McpGatewayTokenScope } from "./runtime-token"

type ResolvedMcpConnection =
  | { ok: true; connectionId: string; token: string; tokenType: "bearer" | "basic"; fields?: Record<string, string> }
  | { ok: false; status: 403 | 404 | 409 | 503; code: string }

function bearer(value: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value ?? "")
  return match?.[1]
}

/** Stateless gateway route. Durable auth and token refresh stay behind the injected owners. */
export function HostedMcpGatewayRoutes(input: {
  env: Record<string, string | undefined>
  authorize(scope: McpGatewayTokenScope): Promise<{ resource: string } | undefined>
  resolveConnection(scope: McpGatewayTokenScope): Promise<ResolvedMcpConnection>
  reportAuthFailure?(scope: McpGatewayTokenScope, connectionId: string): Promise<void>
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}) {
  const app = new Hono()
  app.all("/:integrationId", async (c) => {
    const credential = bearer(c.req.header("authorization"))
    if (!credential) return c.json({ code: "mcp_gateway_unauthorized" }, 401)
    let scope: McpGatewayTokenScope
    try {
      scope = await verifyMcpGatewayToken(credential, { integrationId: c.req.param("integrationId") }, input.env)
    } catch (cause) {
      // A deployment without its verification key is broken, not being probed:
      // answer 503 and say so in the log, instead of the 401 every harness
      // would read as "reconnect", which no reconnect can fix.
      if (cause instanceof McpGatewayConfigurationError) {
        console.error("[agent-plugins] MCP gateway cannot verify credentials", cause.message)
        return c.json({ code: "mcp_gateway_misconfigured" }, 503)
      }
      return c.json({ code: "mcp_gateway_unauthorized", reason: "invalid_token" }, 401)
    }
    // Activation/membership is checked before Connections so a stale runtime
    // credential cannot even probe whether a personal/org Connection exists.
    const authorized = await input.authorize(scope)
    if (!authorized) return c.json({ code: "mcp_gateway_activation_denied" }, 403)
    const connection = await input.resolveConnection(scope)
    if (!connection.ok) return c.json({ code: connection.code }, connection.status)
    if (connection.tokenType !== "bearer" || connection.fields?.resource !== authorized.resource) {
      return c.json({ code: "mcp_gateway_resource_mismatch" }, 409)
    }
    try {
      const response = await forwardMcpGatewayRequest({
        request: c.req.raw,
        resource: authorized.resource,
        token: connection.token,
        tokenType: connection.tokenType,
        fetch: input.fetch,
      })
      if (response.status === 401 || response.status === 403) {
        await input.reportAuthFailure?.(scope, connection.connectionId)
      }
      return response
    } catch (cause) {
      if (cause instanceof McpGatewayError) {
        return c.json({ code: `mcp_gateway_${cause.code.replaceAll("-", "_")}` }, cause.code === "unsupported-method" ? 405 : 502)
      }
      throw cause
    }
  })
  return app
}
