import type { DomainTranslate } from "@/i18n"
import type { TerminalAgentId, WorkspaceRuntime } from "@/server"
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

export function agentsNote(t: DomainTranslate<TerminalKey>, runtime: WorkspaceRuntime, name: string, agents: { readonly isError: boolean; readonly isPending: boolean }) {
  switch (runtime.kind) {
    case "asleep":
      return t("terminal.creator.agentsAsleep", { name })
    case "outdated":
      return t("terminal.creator.agentsOutdated", { name })
    case "wakeFailed":
      return t("terminal.creator.agentsWakeFailed", { name, reason: runtime.error.message })
    case "waking":
      return t("terminal.creator.agentsLoading")
    case "live":
      if (agents.isError) return t("terminal.creator.agentsFailed")
      return agents.isPending ? t("terminal.creator.agentsLoading") : undefined
  }
}
