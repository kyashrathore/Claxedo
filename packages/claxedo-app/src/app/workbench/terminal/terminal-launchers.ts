/**
 * The CLI-agent shortcuts offered by the terminal creator.
 *
 * These used to be hardcoded twice as icon buttons (the rail's project header
 * and the workbench shell header), which meant the roster was whatever those
 * two JSX blocks happened to agree on. It is derived here instead, from the one
 * config the settings pane already writes, so "which agents can I start?" has a
 * single answer that a test can assert against.
 *
 * A launcher with no `command` is a plain login shell — that is the shell's
 * absence of a command, not an empty string, because `openTerminal` treats
 * `command: ""` as "run this" and would spawn a no-op.
 */
import type { TerminalCommands } from "@/features/settings/ui/terminals"

/** Icon key on `ClaxedoIcon`; not every launcher has a vendor mark. */
export type TerminalLauncherIcon = "terminal" | "claude" | "openai"

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

const trimmed = (value: string | undefined) => {
  const next = value?.trim()
  return next ? next : undefined
}

/**
 * Shell first: it is the only launcher guaranteed to work on every workspace,
 * so it is the safe default the keyboard lands on. Vendor agents follow in a
 * fixed order (so the grid does not reshuffle between renders), then whatever
 * the user configured.
 */
export function terminalLaunchers(commands: TerminalCommands): TerminalLauncher[] {
  const launchers: TerminalLauncher[] = [
    { id: "shell", name: "Shell", icon: "terminal" },
  ]

  const claude = trimmed(commands.claude)
  if (claude) launchers.push({ id: "claude", name: "Claude", command: claude, icon: "claude", title: "Claude" })

  const codex = trimmed(commands.codex)
  if (codex) launchers.push({ id: "codex", name: "Codex", command: codex, icon: "openai", title: "Codex" })

  for (const custom of commands.custom ?? []) {
    const command = trimmed(custom.command)
    const name = trimmed(custom.name)
    // The settings pane can hold a half-filled row (it appends a blank one for
    // editing), so a custom entry only becomes a launcher once it has both.
    if (!command || !name) continue
    launchers.push({ id: `custom:${custom.id}`, name, command, icon: "terminal", title: name })
  }

  return launchers
}
