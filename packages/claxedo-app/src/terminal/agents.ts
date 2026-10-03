export type TerminalAgentId = "claude" | "codex" | "cursor" | "gemini"

export type TerminalAgentIcon = "claude" | "openai" | "cursor" | "terminal"

export type TerminalAgent = {
  readonly id: TerminalAgentId
  readonly label: string
  readonly defaultCommand: string
  readonly icon: TerminalAgentIcon
}

export const TERMINAL_AGENTS: readonly TerminalAgent[] = [
  {
    id: "claude",
    label: "Claude",
    defaultCommand: "claude --dangerously-skip-permissions",
    icon: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    defaultCommand: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
    icon: "openai",
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultCommand: "cursor-agent",
    icon: "cursor",
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultCommand: "gemini",
    icon: "terminal",
  },
]
