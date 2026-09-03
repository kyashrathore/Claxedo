import type { JsonRecord } from "../shared/sdk-runtime-driver"
import { record, text } from "../shared/sdk-runtime-values"

/**
 * Projecting a remote MCP server's elicitation as an ordinary Codex question.
 *
 * A plugin's `streamable-http` MCP server asks the user to finish an
 * authorization, or to answer a small form, mid-turn. Both become the same
 * `item/tool/requestUserInput` shape every other Codex prompt uses, so the
 * approval surface needs no plugin-specific case.
 *
 * These live here rather than in `driver.ts` because `server-request.ts` owns
 * the dispatch and the driver imports that handler — putting them in the driver
 * would make the two modules import each other.
 */

const MCP_ELICITATION_CONTINUE = "I've finished connecting"
const MCP_ELICITATION_ALLOW_ONCE = "Allow once"

function isEmptyMcpElicitationForm(params: JsonRecord) {
  if (text(params.mode) !== "form") return false
  const schema = record(params.requestedSchema)
  const properties = record(schema?.properties)
  return schema?.type === "object" && properties !== undefined && Object.keys(properties).length === 0
}

export function codexMcpElicitationQuestion(params: JsonRecord) {
  const serverName = text(params.serverName) ?? "MCP server"
  const message = text(params.message) ?? `${serverName} needs more information.`
  const mode = text(params.mode)
  const url = text(params.url)
  if (mode === "url" && url) {
    return {
      id: "mcp_elicitation",
      header: `Connect ${serverName}`.slice(0, 30),
      question: `${message}\n\nOpen this authorization URL in your browser, finish connecting, then continue:\n${url}`,
      options: [{
        label: MCP_ELICITATION_CONTINUE,
        description: "Continue after the authorization page confirms the connection.",
      }],
      custom: false,
    }
  }
  if (isEmptyMcpElicitationForm(params)) {
    return {
      id: "mcp_elicitation",
      header: `Allow ${serverName}`.slice(0, 30),
      question: message,
      options: [{
        label: MCP_ELICITATION_ALLOW_ONCE,
        description: "Allow this MCP tool call once.",
      }],
      custom: false,
    }
  }
  return {
    id: "mcp_elicitation",
    header: `Answer ${serverName}`.slice(0, 30),
    question: `${message}\n\nEnter one JSON object matching this requested schema:\n${JSON.stringify(params.requestedSchema ?? {}, null, 2)}`,
    options: [],
    custom: true,
  }
}

export function codexMcpElicitationResponse(params: JsonRecord, answer: string | undefined) {
  if (answer === undefined) return { action: "cancel" as const }
  if (text(params.mode) === "url") return { action: "accept" as const }
  if (isEmptyMcpElicitationForm(params)) return { action: "accept" as const, content: {} }
  let content: unknown
  try {
    content = JSON.parse(answer)
  } catch {
    throw new Error("MCP elicitation response must be a JSON object")
  }
  if (!record(content)) throw new Error("MCP elicitation response must be a JSON object")
  return { action: "accept" as const, content }
}
