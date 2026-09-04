import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeStreamEvent } from "../../index"

export function text(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined
}

export function promptText(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const row = part as Record<string, unknown>
    if (typeof row.text === "string") return [row.text]
    if (typeof row.content === "string") return [row.content]
    const resource = row.resource
    if (resource && typeof resource === "object" && typeof (resource as Record<string, unknown>).text === "string") {
      return [(resource as Record<string, string>).text]
    }
    return []
  }).join("\n\n").trim()
}

export function notImplemented(feature: string) {
  return new Error(`${feature} is not implemented for Pi central sessions yet`)
}

export function runtimeEvent(input: AgentRuntimeStreamEvent): input is AgentRuntimeEvent {
  return !("properties" in input)
}
