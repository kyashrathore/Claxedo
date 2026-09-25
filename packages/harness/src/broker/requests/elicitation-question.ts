import { validateElicitationUrl, type AgentQuestion } from "@claxedo/agent-runtime-contract"
import type { PendingRequest } from "../../contract/broker"

export function elicitationQuestion(pending: PendingRequest): AgentQuestion {
  const request = pending.request
  if (request.kind !== "elicitation") throw new Error("Elicitation required")
  if (request.mode === "url") {
    if (!request.url) throw new Error("Consent URL required")
    validateElicitationUrl(request.url)
  }
  const question = request.mode === "url"
    ? `${request.message}\n\nOpen this authorization URL, finish connecting, then continue:\n${request.url}`
    : `${request.message}\n\nEnter one JSON object matching this requested schema:\n${JSON.stringify(request.schema ?? {}, null, 2)}`
  return {
    id: request.requestId,
    sessionID: pending.sessionId,
    questions: [{
      header: request.mode === "url" ? "Connect" : "Answer",
      question,
      options: request.mode === "url"
        ? [{ label: "I've finished connecting", description: "Continue after the authorization page confirms the connection." }]
        : [],
      custom: request.mode === "form",
    }],
  }
}
