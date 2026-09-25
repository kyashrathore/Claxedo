import type { AgentRuntimeEventOf } from "@claxedo/agent-event-runtime/contracts"

export function unrecognizedEvent(protocol: string, method: string, payload: unknown): AgentRuntimeEventOf<"diagnostic"> {
  const raw = Buffer.from(JSON.stringify(payload) ?? "null").subarray(0, 4096).toString("utf8")
  return { type: "diagnostic", diagnostic: {
    code: "unrecognized-event", severity: "warn", source: protocol, method, raw,
    message: `${protocol} event ${method} is not recognized`,
  } }
}
