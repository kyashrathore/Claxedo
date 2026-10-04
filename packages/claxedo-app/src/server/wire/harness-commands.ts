import type { AgentCommand, RuntimeCommand } from "@claxedo/agent-runtime-contract"
import { isRecord } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"

type CommandDetails = Pick<AgentCommand, "description" | "input" | "source">

function commandSource(value: unknown): AgentCommand["source"] {
  return value === "command" || value === "mcp" || value === "skill" ? value : undefined
}

function commandInputFromWire(value: unknown): AgentCommand["input"] {
  if (value === null) return null
  return isRecord(value) && typeof value.hint === "string" ? { hint: value.hint } : undefined
}

function commandDetails(row: Record<string, unknown>): CommandDetails {
  const input = commandInputFromWire(row.input)
  const source = commandSource(row.source)
  return {
    ...(typeof row.description === "string" ? { description: row.description } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(source ? { source } : {}),
  }
}

function runtimeCommand(value: unknown): RuntimeCommand {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw contractMismatch("harness command list")
  if (value.origin === "saved" && typeof value.content === "string") {
    return { name: value.name, origin: "saved", content: value.content, ...commandDetails(value) }
  }
  if (value.origin === "transport") return { name: value.name, origin: "transport", ...commandDetails(value) }
  throw contractMismatch("harness command list")
}

export function runtimeCommandsFromWire(body: unknown): readonly RuntimeCommand[] {
  if (!Array.isArray(body)) throw contractMismatch("harness command list")
  return body.map(runtimeCommand)
}
