import { TERMINAL_AGENTS, terminalAgentInstalled, type TerminalAgentIcon } from "./agents"

export type TerminalLauncher = {
  readonly id: string
  readonly name: string
  readonly command?: string
  readonly icon: TerminalAgentIcon
  readonly title?: string
}

export function terminalLaunchers(
  shellName: string,
  installed: readonly string[] | undefined,
): readonly TerminalLauncher[] {
  const agents = TERMINAL_AGENTS.filter((agent) => !installed || terminalAgentInstalled(agent, installed))
  return [
    { id: "shell", name: shellName, icon: "terminal" },
    ...agents.map((agent) => ({
      id: agent.id,
      name: agent.label,
      command: agent.defaultCommand,
      icon: agent.icon,
      title: agent.label,
    })),
  ]
}
