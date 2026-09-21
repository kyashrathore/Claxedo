import { asRecord, readElicitationSchema, validateElicitationUrl, type AgentElicitation } from "@claxedo/agent-runtime-contract"

/** Decode the agent's form or consent URL without inventing presentation data. */
export function readAcpElicitation(input: unknown, agentName: string): AgentElicitation {
  const params = asRecord(input)
  if (!params || typeof params.message !== "string") throw new Error("Invalid elicitation message")
  if (params.mode === "form") return { agentName, message: params.message, mode: "form", requestedSchema: readElicitationSchema(params.requestedSchema) }
  if (params.mode === "url" && typeof params.url === "string" && typeof params.elicitationId === "string" && params.elicitationId) {
    validateElicitationUrl(params.url)
    return { agentName, message: params.message, mode: "url", url: params.url, elicitationId: params.elicitationId }
  }
  throw new Error("Unsupported elicitation mode")
}
