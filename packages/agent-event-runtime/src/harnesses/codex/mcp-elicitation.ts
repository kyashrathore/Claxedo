import { asRecord } from "@claxedo/helpers/guards"
import { text } from "../../value"
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse"

/** Decode the provider's approval marker and advertised persistence scopes.
 * https://github.com/openai/codex/blob/main/codex-rs/protocol/src/mcp_approval_meta.rs
 * Accept/decline/cancel are MCP response actions, not tool-specific choices.
 */
export function codexMcpApproval(params: Record<string, unknown>) {
  const tool = text(params.serverName)
  const meta = asRecord(params._meta)
  const schema = asRecord(params.requestedSchema)
  const properties = asRecord(schema?.properties)
  if (!tool || params.mode !== "form" || meta?.codex_approval_kind !== "mcp_tool_call"
    || schema?.type !== "object" || !properties || Object.keys(properties).length !== 0) return undefined

  const scopes = typeof meta.persist === "string" ? [meta.persist]
    : Array.isArray(meta.persist) ? meta.persist.filter((scope): scope is string => typeof scope === "string") : []
  const actions = ["accept", "decline", "cancel"] as const
  const options = [
    ...actions.map((action) => ({
      id: action,
      label: action[0]!.toUpperCase() + action.slice(1),
      response: { action, content: action === "accept" ? {} : null, _meta: null } satisfies McpServerElicitationRequestResponse,
    })),
    ...Array.from(new Set(scopes)).map((scope) => ({
      id: JSON.stringify({ persist: scope }),
      label: `Accept (${scope})`,
      response: { action: "accept", content: {}, _meta: { persist: scope } } satisfies McpServerElicitationRequestResponse,
    })),
  ]
  return {
    tool,
    reason: text(params.message),
    options,
  }
}
