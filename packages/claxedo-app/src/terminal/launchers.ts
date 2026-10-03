import { TERMINAL_AGENTS, type TerminalAgentIcon } from "./agents"

export type TerminalLauncher = {
  readonly id: string
  readonly name: string
  readonly command?: string
  readonly icon: TerminalAgentIcon
  readonly title?: string
}

export function terminalLaunchers(shellName: string): readonly TerminalLauncher[] {
  return [
    { id: "shell", name: shellName, icon: "terminal" },
    ...TERMINAL_AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.label,
      command: agent.defaultCommand,
      icon: agent.icon,
      title: agent.label,
    })),
  ]
}
