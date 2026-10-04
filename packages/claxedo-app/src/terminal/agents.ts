import type { TerminalAgentId } from "@/server"
import type { TerminalKey } from "./i18n"

export type TerminalAgentIcon = "claude" | "openai" | "cursor" | "terminal"

export type TerminalAgent = {
  readonly id: TerminalAgentId
  readonly label: string
  readonly description: TerminalKey
  readonly defaultCommand: string
  readonly icon: TerminalAgentIcon
}

export const TERMINAL_AGENTS: readonly TerminalAgent[] = [
  {
    id: "claude",
    label: "Claude",
    description: "terminal.creator.claude",
    defaultCommand: "claude --dangerously-skip-permissions",
    icon: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    description: "terminal.creator.codex",
    defaultCommand: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
    icon: "openai",
  },
  {
    id: "cursor",
    label: "Cursor",
    description: "terminal.creator.cursor",
    defaultCommand: "cursor-agent",
    icon: "cursor",
  },
]
