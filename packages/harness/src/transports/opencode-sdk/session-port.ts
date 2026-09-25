import type { OpenCodeHost } from "./host.js"
import type { OpenCodeSessionPort } from "./session-types.js"
import { sessionManagement } from "./session-management.js"
import { sessionTurns } from "./session-turns.js"

export function openCodePartId(messageID: string, role: string, content: { id?: unknown }, ordinal: number): string {
  if (role === "user") return `${messageID}:text`
  return typeof content.id === "string" ? content.id : `${messageID}:${String(ordinal).padStart(6, "0")}`
}

export * from "./session-types.js"

export function createSessionPort(host: OpenCodeHost): OpenCodeSessionPort {
  return { ...sessionManagement(host), ...sessionTurns(host) }
}
