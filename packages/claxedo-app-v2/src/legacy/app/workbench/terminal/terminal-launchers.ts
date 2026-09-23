/**
 * The CLI-agent shortcuts offered by the terminal creator.
 *
 * Derived from the agent catalog and the one config the settings pane writes,
 * so "which agents can I start?" has a single answer that a test can assert
 * against.
 *
 * A launcher with no `command` is a plain login shell — that is the shell's
 * absence of a command, not an empty string, because `openTerminal` treats
 * `command: ""` as "run this" and would spawn a no-op.
 */
import type { TerminalCommands } from "@/features/terminal/core/terminal-commands"
import {
  TERMINAL_AGENTS,
  terminalAgentInstalled,
  type TerminalAgentIcon,
} from "@/features/terminal/core/terminal-agents"
import { trimToUndefined } from "@claxedo/helpers/string"

export type TerminalLauncherIcon = TerminalAgentIcon

export type TerminalLauncher = {
  /** Stable across renders so the grid can key on it. */
  id: string
  name: string
  /** Undefined means "plain shell", never an empty command string. */
  command?: string
  icon: TerminalLauncherIcon
  /** Tab title for the spawned terminal. Shell terminals keep the generic title. */
  title?: string
}

/**
 * Shell first: it is the only launcher guaranteed to work on every workspace,
 * so it is the safe default the keyboard lands on. Catalog agents follow in
 * catalog order (so the grid does not reshuffle between renders), then whatever
 * the user configured.
 *
 * `installed` is the machine's answer to "which of these binaries are on PATH".
 * Leaving it undefined offers every agent: an unanswered probe must not be the
 * reason a launcher the user has disappears.
 */
export function terminalLaunchers(
  commands: TerminalCommands,
  installed?: readonly string[],
): TerminalLauncher[] {
  const launchers: TerminalLauncher[] = [
    { id: "shell", name: "Shell", icon: "terminal" },
  ]

  for (const agent of TERMINAL_AGENTS) {
    const command = trimToUndefined(commands.agents[agent.id])
    if (!command) continue
    if (installed && !terminalAgentInstalled(agent, installed)) continue
    launchers.push({ id: agent.id, name: agent.label, command, icon: agent.icon, title: agent.label })
  }

  // Custom entries are never filtered by the probe: the command is the user's
  // own text, which can be a shell line rather than a binary to look up.
  for (const custom of commands.custom ?? []) {
    const command = trimToUndefined(custom.command)
    const name = trimToUndefined(custom.name)
    // The settings pane can hold a half-filled row (it appends a blank one for
    // editing), so a custom entry only becomes a launcher once it has both.
    if (!command || !name) continue
    launchers.push({ id: `custom:${custom.id}`, name, command, icon: "terminal", title: name })
  }

  return launchers
}
