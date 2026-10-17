import { asRecord, isBoolean, isNonEmptyString, isStringList } from "@claxedo/helpers/guards"

export const MCP_APP_MIME = "text/html;profile=mcp-app"
export const MCP_APP_MAX_BYTES = 2 * 1024 * 1024
export const MCP_APP_DOMAIN_LIMIT = 32
export const MCP_APP_DOMAIN_MAX_LENGTH = 256

export const MCP_APP_CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const

export type McpAppCsp = Partial<Record<(typeof MCP_APP_CSP_KEYS)[number], readonly string[]>>

export type McpAppReference = {
  readonly resourceUri: string
  readonly csp?: McpAppCsp
  readonly prefersBorder?: boolean
}

export type ToolMcpFacts = {
  readonly server: string
  readonly tool: string
  readonly resultMeta?: Record<string, unknown>
  readonly structuredContent?: unknown
  readonly app?: McpAppReference
}

function domainOrigin(value: string): string | undefined {
  if (value.length > MCP_APP_DOMAIN_MAX_LENGTH || value.includes("*")) return undefined
  try {
    const url = new URL(value)
    return (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "wss:" || url.protocol === "ws:") && url.origin === value.replace(/\/$/, "") ? url.origin : undefined
  } catch {
    return undefined
  }
}

export function mcpAppCsp(value: unknown): McpAppCsp | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const csp = Object.fromEntries(
    MCP_APP_CSP_KEYS.flatMap((key) => {
      const list = record[key]
      if (!isStringList(list)) return []
      const origins = list.flatMap((entry) => domainOrigin(entry) ?? []).slice(0, MCP_APP_DOMAIN_LIMIT)
      return origins.length > 0 ? [[key, origins]] : []
    }),
  )
  return Object.keys(csp).length > 0 ? csp : undefined
}

export type McpToolAudience = "model" | "app"

export function mcpToolVisibleTo(toolMeta: unknown, audience: McpToolAudience): boolean {
  const visibility = asRecord(asRecord(toolMeta)?.ui)?.visibility
  return !Array.isArray(visibility) || visibility.includes(audience)
}

export function mcpAppResourceUri(toolMeta: unknown): string | undefined {
  const meta = asRecord(toolMeta)
  const uri = asRecord(meta?.ui)?.resourceUri ?? meta?.["ui/resourceUri"]
  return isNonEmptyString(uri) && uri.startsWith("ui://") ? uri : undefined
}

function mcpAppReference(value: unknown): McpAppReference | undefined {
  const record = asRecord(value)
  if (!record || !isNonEmptyString(record.resourceUri)) return undefined
  const csp = mcpAppCsp(record.csp)
  return {
    resourceUri: record.resourceUri,
    ...(csp ? { csp } : {}),
    ...(isBoolean(record.prefersBorder) ? { prefersBorder: record.prefersBorder } : {}),
  }
}

export function toolMcpFacts(metadata: Record<string, unknown> | undefined): ToolMcpFacts | undefined {
  const mcp = asRecord(metadata?.mcp)
  if (!mcp || !isNonEmptyString(mcp.server) || !isNonEmptyString(mcp.tool)) return undefined
  const resultMeta = asRecord(mcp.resultMeta)
  const app = mcpAppReference(mcp.app)
  return {
    server: mcp.server,
    tool: mcp.tool,
    ...(resultMeta ? { resultMeta } : {}),
    ...(mcp.structuredContent === undefined ? {} : { structuredContent: mcp.structuredContent }),
    ...(app ? { app } : {}),
  }
}

export function toolMcpHeader(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const facts = toolMcpFacts(metadata)
  return facts ? { mcp: { server: facts.server, tool: facts.tool, ...(facts.app ? { app: facts.app } : {}) } } : {}
}
