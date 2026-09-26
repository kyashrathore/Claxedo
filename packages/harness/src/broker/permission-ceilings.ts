import type { PermissionRequest } from "../contract/broker"

export const CLAUDE_COMMAND_DENY_RULES = ["Bash(rm -rf /*)", "Bash(rm -rf ~*)", "Bash(git push --force*)", "Bash(curl *| sh)",
  "Bash(curl *| bash)", "Bash(wget *| sh)", "Bash(chmod -R 777*)"] as const

function matchesRule(command: string, rule: string): boolean {
  const pattern = rule.slice("Bash(".length, -1).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${pattern}$`).test(command)
}

export function permissionCeilingDenies(connectionId: string, request: PermissionRequest): boolean {
  if (connectionId !== "claude-sdk" || request.permission.permission !== "Bash") return false
  const input = request.permission.metadata?.input
  if (!input || typeof input !== "object" || !("command" in input) || typeof input.command !== "string") return false
  const command = input.command
  return CLAUDE_COMMAND_DENY_RULES.some((rule) => matchesRule(command, rule))
}
