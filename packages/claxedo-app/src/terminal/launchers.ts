import type { TerminalAgentId } from "@/server"
import { TERMINAL_AGENTS, type TerminalAgentIcon } from "./agents"
import type { TerminalKey } from "./i18n"

export type TerminalLauncher = {
  readonly id: string
  readonly name: string
  readonly description: TerminalKey
  readonly command?: string
  readonly icon: TerminalAgentIcon
  readonly title?: string
}

export function terminalLaunchers(shellName: string, installed: readonly TerminalAgentId[]): readonly TerminalLauncher[] {
  return [
    { id: "shell", name: shellName, description: "terminal.creator.loginShell", icon: "terminal" },
    ...TERMINAL_AGENTS.filter((agent) => installed.includes(agent.id)).map((agent) => ({
      id: agent.id,
      name: agent.label,
      description: agent.description,
      command: agent.defaultCommand,
      icon: agent.icon,
      title: agent.label,
    })),
  ]
}
