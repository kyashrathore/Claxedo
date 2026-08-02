import { parse as parseShellCommand } from "shell-quote"

/**
 * Gating for a terminal's one-shot "initial command". Agent launchers
 * (claude/codex/gemini/cursor) are never auto-typed into a fresh PTY — the app
 * launches those through its own harness path, so replaying them as raw shell
 * input would spawn a duplicate. Everything else is sent verbatim once.
 *
 * Extracted from terminal.tsx so the drop-vs-send decision is unit-testable
 * without mounting the xterm backend.
 */

const AGENT_LAUNCH_COMMANDS = new Set(["claude", "codex", "gemini", "cursor", "cursor-agent"])

export function isAgentLaunchCommand(input?: string): boolean {
  if (!input?.trim()) return false
  try {
    const parsed = parseShellCommand(input)
    if (!parsed.every((item): item is string => typeof item === "string")) return false
    const command = parsed[0]
    if (!command) return false
    const name = command.split(/[\\/]/).pop()
    return name !== undefined && AGENT_LAUNCH_COMMANDS.has(name)
  } catch {
    return false
  }
}

export interface ResolvedInitialCommand {
  /** The command to send to the PTY once connected; "" means send nothing. */
  readonly command: string
  /** Whether the persisted initialCommand should be cleared (agent launchers are dropped, not sent). */
  readonly clearStored: boolean
}

/**
 * Resolves the raw persisted initialCommand into what should actually run.
 * Agent-launch commands resolve to an empty command AND request that the stored
 * value be cleared, so a reload does not keep trying to replay them.
 */
export function resolveInitialCommand(raw: string | undefined): ResolvedInitialCommand {
  const rawInitialCmd = raw ?? ""
  const command = isAgentLaunchCommand(rawInitialCmd) ? "" : rawInitialCmd
  return { command, clearStored: !!rawInitialCmd && !command }
}
