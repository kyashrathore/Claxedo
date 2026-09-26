export type TerminalAgentId = "claude" | "codex" | "cursor" | "gemini"

export type TerminalAgentIcon = "claude" | "openai" | "cursor" | "terminal"

export type TerminalAgent = {
  readonly id: TerminalAgentId
  readonly label: string
  readonly binaries: readonly [string, ...string[]]
  readonly defaultCommand: string
  readonly icon: TerminalAgentIcon
}

export const TERMINAL_AGENTS: readonly TerminalAgent[] = [
  {
    id: "claude",
    label: "Claude",
    binaries: ["claude"],
    defaultCommand: "claude --dangerously-skip-permissions",
    icon: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    defaultCommand: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
    icon: "openai",
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor-agent", "cursor"],
    defaultCommand: "cursor-agent",
    icon: "cursor",
  },
  {
    id: "gemini",
    label: "Gemini",
    binaries: ["gemini"],
    defaultCommand: "gemini",
    icon: "terminal",
  },
]

export function terminalAgentInstalled(agent: TerminalAgent, installed: readonly string[]): boolean {
  return agent.binaries.some((binary) => installed.includes(binary))
}
