import { isDeepStrictEqual } from "node:util"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"

type CommandGrant = { directory: string; mode: string | null; input: Record<string, unknown>; context: Record<string, unknown> }

const callbackFields = new Set(["signal", "toolUseID", "requestId", "title", "displayName", "description"])

/**
 * A grant is compared against one the store has already round-tripped through JSON, so a
 * fresh grant has to hold what a parse would return: `JSON.stringify` yields `undefined`
 * for exactly the values a parsed record cannot contain.
 */
function jsonEntries(entries: [string, unknown][]): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const encoded = JSON.stringify(value)
    if (encoded !== undefined) record[key] = JSON.parse(encoded)
  }
  return record
}

/** Remember the accepted command, not broader Edit access to a redirection target. */
export function claudeCommandGrant(
  tool: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  directory: string,
  mode: string | undefined,
): CommandGrant | undefined {
  if (tool !== "Bash" || typeof input.command !== "string" || !input.command || !directory || !options.blockedPath) return undefined
  // An explicit ask policy or a new safety explanation must reach the user.
  if (options.matchedAskRule || options.decisionReason || options.signal.aborted) return undefined
  return {
    directory,
    mode: mode ?? null,
    input: jsonEntries(Object.entries(input).filter(([key]) => key !== "description")),
    context: jsonEntries(Object.entries(options).filter(([key]) => !callbackFields.has(key))),
  }
}

export function hasClaudeCommandGrant(state: Record<string, unknown> | undefined, grant: CommandGrant) {
  const grants = state?.claudeCommandGrants
  return Array.isArray(grants) && grants.some((saved) => isDeepStrictEqual(saved, grant))
}

export function withClaudeCommandGrant(state: Record<string, unknown>, grant: CommandGrant) {
  if (hasClaudeCommandGrant(state, grant)) return state
  const grants = Array.isArray(state.claudeCommandGrants) ? state.claudeCommandGrants : []
  return { ...state, claudeCommandGrants: [...grants, grant] }
}
