/**
 * The commands terminal launchers run, as this browser profile has them.
 *
 * Stored flat by agent id (`{ claude, codex, ..., custom }`) so a value saved
 * before an agent joined the catalog is still the value that agent launches.
 */
import { isRecord } from "@/lib/record"
import { TERMINAL_AGENTS, type TerminalAgentId } from "./terminal-agents"

const TERMINAL_COMMANDS_KEY = "claxedo.terminalCommands"

export type CustomCommand = {
  id: string
  name: string
  command: string
}

export type TerminalCommands = {
  agents: Record<TerminalAgentId, string>
  custom: CustomCommand[]
}

function isCustomCommand(input: unknown): input is CustomCommand {
  return (
    isRecord(input) &&
    typeof input.id === "string" &&
    typeof input.name === "string" &&
    typeof input.command === "string"
  )
}

export function defaultTerminalCommands(): TerminalCommands {
  return { agents: agentCommands(undefined), custom: [] }
}

function agentCommands(input: Record<string, unknown> | undefined): Record<TerminalAgentId, string> {
  const agents: Record<string, string> = {}
  for (const agent of TERMINAL_AGENTS) {
    const stored = input?.[agent.id]
    agents[agent.id] = typeof stored === "string" ? stored : agent.defaultCommand
  }
  return agents
}

function storedCommands(input: unknown): TerminalCommands {
  if (!isRecord(input)) return defaultTerminalCommands()
  return {
    agents: agentCommands(input),
    custom: Array.isArray(input.custom) ? input.custom.filter(isCustomCommand) : [],
  }
}

export function getTerminalCommands(): TerminalCommands {
  if (typeof localStorage === "undefined") return defaultTerminalCommands()
  try {
    const stored = localStorage.getItem(TERMINAL_COMMANDS_KEY)
    if (stored) return storedCommands(JSON.parse(stored) as unknown)
  } catch {
    return defaultTerminalCommands()
  }
  return defaultTerminalCommands()
}

export function saveTerminalCommands(commands: TerminalCommands) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(TERMINAL_COMMANDS_KEY, JSON.stringify({ ...commands.agents, custom: commands.custom }))
}
