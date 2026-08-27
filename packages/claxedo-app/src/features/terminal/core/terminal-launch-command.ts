import { parse as parseShellCommand } from "shell-quote"

export function terminalLaunchCommand(input?: string) {
  if (!input?.trim()) return
  const parsed = parseShellCommand(input)
  if (!parsed.every((item): item is string => typeof item === "string")) return

  const command = parsed[0]
  if (!command) return

  const name = command.split(/[\\/]/).pop()
  if (name !== "claude" && name !== "codex" && name !== "gemini" && name !== "cursor" && name !== "cursor-agent") return

  return {
    command,
    args: parsed.slice(1),
  }
}
