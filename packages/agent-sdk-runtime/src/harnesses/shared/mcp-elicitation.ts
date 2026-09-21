import type { JsonRecord } from "./sdk-runtime-driver"
import { asRecord } from "@claxedo/helpers/guards"
import { text } from "./sdk-runtime-values"

/** URL authorization and data forms are questions; empty consent forms use permissions. */
const MCP_ELICITATION_CONTINUE = "I've finished connecting"

export function mcpElicitationQuestion(params: JsonRecord) {
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
  return {
    id: "mcp_elicitation",
    header: `Answer ${serverName}`.slice(0, 30),
    question: `${message}\n\nEnter one JSON object matching this requested schema:\n${JSON.stringify(params.requestedSchema ?? {}, null, 2)}`,
    options: [],
    custom: true,
  }
}

export function mcpElicitationResponse(params: JsonRecord, answer: string | undefined) {
  if (answer === undefined) return { action: "cancel" as const }
  if (text(params.mode) === "url") return { action: "accept" as const }
  let content: unknown
  try {
    content = JSON.parse(answer)
  } catch {
    throw new Error("MCP elicitation response must be a JSON object")
  }
  if (!asRecord(content)) throw new Error("MCP elicitation response must be a JSON object")
  return { action: "accept" as const, content }
}
