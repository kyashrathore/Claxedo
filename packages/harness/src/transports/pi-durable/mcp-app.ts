import { MCP_APP_MAX_BYTES, MCP_APP_MIME, mcpAppCsp, type McpAppReference } from "@claxedo/agent-runtime-contract"
import { asRecord, isBoolean } from "@claxedo/helpers/guards"
import type { ClientCapabilities, ReadResourceResult } from "@earendil-works/pi-mcp"
import { attachmentBytes } from "../../translate/tool-attachments"

export const PI_MCP_CAPABILITIES: ClientCapabilities & { extensions: Record<string, unknown> } = {
  extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } },
}

export type McpAppSnapshot = { document: string; app: McpAppReference }

export type McpAppCapture = { ok: true; snapshot: McpAppSnapshot } | { ok: false; reason: string }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function documentPayload(content: ReadResourceResult["contents"][number]): string | { failure: string } {
  if ("blob" in content) {
    if (attachmentBytes(content.blob) > MCP_APP_MAX_BYTES) return { failure: "exceeds the size limit" }
    return BASE64.test(content.blob) ? content.blob : { failure: "is not base64" }
  }
  if (content.text.length > MCP_APP_MAX_BYTES) return { failure: "exceeds the size limit" }
  const bytes = new TextEncoder().encode(content.text)
  return bytes.length > MCP_APP_MAX_BYTES ? { failure: "exceeds the size limit" } : base64(bytes)
}

function appReference(resourceUri: string, contentMeta: unknown): McpAppReference {
  const ui = asRecord(asRecord(contentMeta)?.ui)
  const csp = mcpAppCsp(ui?.csp)
  return {
    resourceUri,
    ...(csp ? { csp } : {}),
    ...(isBoolean(ui?.prefersBorder) ? { prefersBorder: ui.prefersBorder } : {}),
  }
}

export function mcpAppSnapshot(resourceUri: string, resource: ReadResourceResult): McpAppCapture {
  const content = resource.contents.find((item) => item.mimeType === MCP_APP_MIME)
  if (!content) return { ok: false, reason: `${resourceUri} has no ${MCP_APP_MIME} content` }
  const payload = documentPayload(content)
  if (typeof payload !== "string") return { ok: false, reason: `${resourceUri} ${payload.failure}` }
  return { ok: true, snapshot: { document: `data:${MCP_APP_MIME};base64,${payload}`, app: appReference(resourceUri, content._meta) } }
}
