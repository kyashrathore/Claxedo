import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { TransportError } from "../../contract/errors"

export type ClaudePermissionRules = { allow: string[]; deny: string[]; ask: string[]; additionalDirectories: string[] }

export type ClaudeGrant = { key: string; updates?: PermissionUpdate[] }

type GrantContext = { directory: string; permissionMode: string }

const protocolRuleBehaviorMap = { allow: "allow", deny: "deny", ask: "ask" } as const
const protocolPermissionStateMap: readonly (keyof ClaudePermissionRules)[] = ["allow", "deny", "ask", "additionalDirectories"]

const invalidClaudeGrant = (message: string, cause?: unknown) => new TransportError("claude", "configuration", message, cause === undefined ? undefined : { cause })

export function sessionPermissionUpdates(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] | undefined {
  if (!suggestions?.length) return undefined
  return suggestions.map((update) => ({ ...update, destination: "session" as const }))
}

export function claudeGrant(context: GrantContext, toolName: string, toolInput: Record<string, unknown>,
  options: Parameters<CanUseTool>[2]): ClaudeGrant | undefined {
  if (options.matchedAskRule) return undefined
  const updates = sessionPermissionUpdates(options.suggestions)
  if (updates) return { key: JSON.stringify({ tool: toolName, directory: context.directory, updates }), updates }
  if (toolName !== "Bash" || typeof toolInput.command !== "string" || !toolInput.command || !options.blockedPath) return undefined
  return { key: JSON.stringify({ tool: toolName, directory: context.directory, identity: {
    toolInput: Object.fromEntries(Object.entries(toolInput).filter(([key]) => key !== "description")),
    mode: context.permissionMode, blockedPath: options.blockedPath, agentID: options.agentID } }) }
}

function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { destination?: unknown }).destination === "string"
}

export function claudeGrantUpdates(keys: readonly string[]): PermissionUpdate[] {
  return keys.flatMap((key) => {
    let parsed: unknown
    try { parsed = JSON.parse(key) }
    catch (error) { throw invalidClaudeGrant("Invalid persisted Claude grant", error) }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidClaudeGrant("Invalid persisted Claude grant")
    const updates = (parsed as { updates?: unknown }).updates
    if (updates === undefined) return []
    if (!Array.isArray(updates) || !updates.every(isPermissionUpdate)) throw invalidClaudeGrant("Invalid persisted Claude grant updates")
    return updates
  })
}

export function persistedClaudeRules(state: Record<string, unknown> | undefined): ClaudePermissionRules {
  const rules: ClaudePermissionRules = { allow: [], deny: [], ask: [], additionalDirectories: [] }
  for (const key of protocolPermissionStateMap) {
    const row = state?.[key]
    if (row === undefined) continue
    if (!Array.isArray(row) || row.some((value) => typeof value !== "string")) throw invalidClaudeGrant(`Invalid Claude ${key} permission state`)
    rules[key] = row.filter((value: unknown): value is string => typeof value === "string")
  }
  return rules
}

function ruleText(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`
}

export function replayClaudePermissionUpdates(rules: ClaudePermissionRules, updates: readonly PermissionUpdate[]): ClaudePermissionRules {
  const next = { ...rules }
  for (const update of updates) {
    if (update.type === "setMode") continue
    if (update.type === "addDirectories") { next.additionalDirectories = [...new Set([...next.additionalDirectories, ...update.directories])]; continue }
    if (update.type === "removeDirectories") { next.additionalDirectories = next.additionalDirectories.filter((value) => !update.directories.includes(value)); continue }
    const behavior = protocolRuleBehaviorMap[update.behavior]
    if (!behavior) throw invalidClaudeGrant(`Unsupported Claude rule behavior ${update.behavior}`)
    const changed = update.rules.map(ruleText)
    next[behavior] = update.type === "replaceRules" ? changed
      : update.type === "removeRules" ? next[behavior].filter((value) => !changed.includes(value))
      : [...new Set([...next[behavior], ...changed])]
  }
  return next
}
