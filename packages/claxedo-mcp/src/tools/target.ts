/**
 * Which workspace a tool call addresses, whether this credential may write
 * there, and how the answer is rendered.
 *
 * Every group needs the same three things around its client call, and the
 * second is a security boundary: security review S2 keeps a runtime credential
 * — a model inside a session, prompt injection assumed — from writing to the
 * user's other machines unless the account setting is on. The check lives here
 * so a new tool cannot forget it in a way that reads like an oversight.
 */
import { z } from "zod"
import { McpAccessDenied, type McpToolContext } from "../context"
import type { WorkspaceTarget } from "../client/contract"
import type { McpToolResult } from "../mcp-tool"

/** The two arguments every workspace-addressed tool takes. */
export const WORKSPACE_TARGET_SCHEMA = {
  workspace: z.string().trim().min(1).optional().describe("Workspace id. Defaults to the caller's own workspace."),
  directory: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Project or worktree directory inside that workspace. Defaults to the workspace's own directory."),
} as const

export type WorkspaceTargetArgs = Readonly<{ workspace?: string; directory?: string }>

export function toolTarget(ctx: McpToolContext, args: WorkspaceTargetArgs): WorkspaceTarget {
  const workspaceId = args.workspace ?? (ctx.credential.kind === "runtime" ? ctx.credential.workspaceId : ctx.client.ownWorkspace?.workspaceId)
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(args.directory ? { directory: args.directory } : {}),
  }
}

/**
 * Refuses a write a runtime credential aims at a workspace other than its own.
 *
 * A directory alone never crosses a machine: the loopback client serves an
 * unqualified target from the runtime in its own process, and the hosted
 * client refuses a directory it cannot name a workspace for.
 */
export function assertWritableTarget(ctx: McpToolContext, tool: string, target: WorkspaceTarget): void {
  const { credential } = ctx
  if (credential.kind !== "runtime" || credential.crossMachineWrites) return
  if (!target.workspaceId || target.workspaceId === credential.workspaceId) return
  throw new McpAccessDenied(
    "cross-machine",
    `${tool} would write to workspace ${target.workspaceId}; this session may only write to ${credential.workspaceId} until the account allows agents to act on other machines`,
  )
}

/** The per-call scope the typed client puts on the query string. */
export function targetScope(target: WorkspaceTarget) {
  return {
    ...(target.workspaceId ? { workspace: target.workspaceId } : {}),
    ...(target.directory ? { directory: target.directory } : {}),
  }
}

export function toolJson(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

export function toolText(value: string): McpToolResult {
  return { content: [{ type: "text", text: value }] }
}
