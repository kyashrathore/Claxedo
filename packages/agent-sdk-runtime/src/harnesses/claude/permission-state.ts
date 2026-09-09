import { isDeepStrictEqual } from "node:util"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"

type CommandGrant = { directory: string; mode: string | null; input: Record<string, unknown>; context: Record<string, unknown> }

const callbackFields = new Set(["signal", "toolUseID", "requestId", "title", "displayName", "description"])

/** Remember the accepted command, not broader Edit access to a redirection target. */
export function claudeCommandGrant(
  tool: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  directory: string,
  mode: string | undefined,
): CommandGrant | undefined {
  if (tool !== "Bash" || typeof input.command !== "string" || !input.command || !directory || !options.blockedPath) return
  // An explicit ask policy or a new safety explanation must reach the user.
  if (options.matchedAskRule || options.decisionReason || options.signal.aborted) return
  return JSON.parse(JSON.stringify({
    directory, mode: mode ?? null,
    input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "description")),
    context: Object.fromEntries(Object.entries(options).filter(([key]) => !callbackFields.has(key))),
  })) as CommandGrant
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
