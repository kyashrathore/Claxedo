import type { AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { frameExcerpt } from "./frame-excerpt"

export function unrecognizedEvent(protocol: string, method: string, payload: unknown): AgentRuntimeEventOf<"diagnostic"> {
  return { type: "diagnostic", diagnostic: {
    code: "unrecognized-event", severity: "warn", source: protocol, method, raw: frameExcerpt(payload).excerpt,
    message: `${protocol} event ${method} is not recognized`,
  } }
}
