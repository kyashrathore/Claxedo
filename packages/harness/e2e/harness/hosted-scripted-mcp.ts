import { appendFile } from "node:fs/promises"
import type { IncomingMessage } from "node:http"
import path from "node:path"

export const HOSTED_MCP_RESOURCE = "https://mcp.hosted-e2e.test/mcp"
export const HOSTED_MCP_ISSUER = "https://auth.hosted-e2e.test"
export const HOSTED_MCP_CLIENT_ID = "hosted-e2e-mcp-client"
export const HOSTED_MCP_UPSTREAM_TOKEN = "hosted-e2e-upstream-access-token"
export const HOSTED_MCP_AUTHORIZATION_CODE = "hosted-e2e-authorization-code"
/** A public address, so the control plane's private-destination policy admits both scripted hosts. */
const PUBLIC_ADDRESS = "93.184.216.34"

export type HostedMcpUpstreamCall =
  | { kind: "token"; grantType: string | null; code: string | null; clientId: string | null; resource: string | null; hasVerifier: boolean }
  | { kind: "rpc"; method: string; authorization: string | null; marker?: string }

export function hostedMcpCallsFile(root: string) {
  return path.join(root, "hosted-mcp-upstream-calls.jsonl")
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * The scripted OAuth-protected MCP server behind the hosted plugin gateway,
 * with its authorization server and the DNS-over-HTTPS answers the control
 * plane's destination policy asks for. Every request the Worker or the
 * gateway makes to these hosts lands here; nothing else answers them.
 */
export async function scriptedHostedMcp(request: IncomingMessage, url: URL, root: string): Promise<Response | undefined> {
  const record = (call: HostedMcpUpstreamCall) => appendFile(hostedMcpCallsFile(root), `${JSON.stringify(call)}\n`)
  if (url.origin === "https://1.1.1.1" && url.pathname === "/dns-query") {
    const name = url.searchParams.get("name")
    if (name !== "mcp.hosted-e2e.test" && name !== "auth.hosted-e2e.test") return undefined
    const wanted = url.searchParams.get("type") === "A"
    return Response.json({ Status: 0, Answer: wanted ? [{ name, type: 1, TTL: 60, data: PUBLIC_ADDRESS }] : [] })
  }
  if (url.origin === HOSTED_MCP_ISSUER) {
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: HOSTED_MCP_ISSUER,
        authorization_endpoint: `${HOSTED_MCP_ISSUER}/authorize`,
        token_endpoint: `${HOSTED_MCP_ISSUER}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const form = new URLSearchParams(await body(request))
      const call: HostedMcpUpstreamCall = {
        kind: "token",
        grantType: form.get("grant_type"),
        code: form.get("code"),
        clientId: form.get("client_id"),
        resource: form.get("resource"),
        hasVerifier: Boolean(form.get("code_verifier")),
      }
      await record(call)
      if (call.grantType !== "authorization_code" || call.code !== HOSTED_MCP_AUTHORIZATION_CODE || call.clientId !== HOSTED_MCP_CLIENT_ID || !call.hasVerifier) {
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return Response.json({ access_token: HOSTED_MCP_UPSTREAM_TOKEN, token_type: "bearer", expires_in: 3600 })
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  }
  if (url.origin !== "https://mcp.hosted-e2e.test") return undefined
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return Response.json({ resource: HOSTED_MCP_RESOURCE, authorization_servers: [HOSTED_MCP_ISSUER] })
  }
  if (url.pathname !== "/mcp") return Response.json({ error: "not_found" }, { status: 404 })
  const authorization = request.headers.authorization ?? null
  const raw = request.method === "POST" ? await body(request) : ""
  const message = raw ? JSON.parse(raw) as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } : {}
  if (authorization !== `Bearer ${HOSTED_MCP_UPSTREAM_TOKEN}`) {
    await record({ kind: "rpc", method: message.method ?? request.method ?? "unknown", authorization })
    return new Response(null, {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="https://mcp.hosted-e2e.test/.well-known/oauth-protected-resource/mcp"` },
    })
  }
  const marker = typeof message.params?.arguments?.marker === "string" ? message.params.arguments.marker : undefined
  await record({ kind: "rpc", method: message.method ?? "unknown", authorization, ...(marker ? { marker } : {}) })
  if (message.id === undefined) return new Response(null, { status: 202 })
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "hosted-scripted-mcp", version: "1.0.0" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "proof", description: "Return a hosted proof marker", inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] } }] }
      : message.method === "tools/call" && message.params?.name === "proof"
        ? { content: [{ type: "text", text: `MCP_PROOF:${marker ?? ""}` }] }
        : undefined
  return Response.json(result === undefined
    ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
    : { jsonrpc: "2.0", id: message.id, result })
}
