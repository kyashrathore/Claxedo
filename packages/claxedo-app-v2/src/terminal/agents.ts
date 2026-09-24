import { parse as parseShellCommand } from "shell-quote"

export type TerminalAgentId = "claude" | "codex" | "cursor" | "gemini"

export type TerminalAgent = {
  readonly id: TerminalAgentId
  readonly label: string
  readonly binaries: readonly [string, ...string[]]
  readonly defaultCommand: string
}

export const TERMINAL_AGENTS: readonly TerminalAgent[] = [
  { id: "claude", label: "Claude", binaries: ["claude"], defaultCommand: "claude --dangerously-skip-permissions" },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    defaultCommand: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
  },
  { id: "cursor", label: "Cursor", binaries: ["cursor-agent", "cursor"], defaultCommand: "cursor-agent" },
  { id: "gemini", label: "Gemini", binaries: ["gemini"], defaultCommand: "gemini" },
]

export function terminalAgent(id: string): TerminalAgent | undefined {
  return TERMINAL_AGENTS.find((agent) => agent.id === id)
}

export function terminalAgentInstalled(agent: TerminalAgent, installed: readonly string[]): boolean {
  return agent.binaries.some((binary) => installed.includes(binary))
}

export function isTerminalAgentBinary(name: string): boolean {
  return TERMINAL_AGENTS.some((agent) => (agent.binaries as readonly string[]).includes(name))
}

export function terminalLaunchCommand(input?: string): { command: string; args: string[] } | undefined {
  if (!input?.trim()) return undefined
  const parsed = parseShellCommand(input)
  if (!parsed.every((item): item is string => typeof item === "string")) return undefined
  const command = parsed[0]
  if (!command) return undefined
  const name = command.split(/[\\/]/).pop()
  if (!name || !isTerminalAgentBinary(name)) return undefined
  return { command, args: parsed.slice(1) }
}
