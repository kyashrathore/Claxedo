/**
 * Which session a runtime credential may act on.
 *
 * The workspace check in `target.ts` admits every session of a workspace this
 * credential may write to, so on its own it lets the model inside one session
 * drive the sessions a person started beside it (security review P11).
 *
 * Both halves of the answer are asked inside the credential's own workspace.
 * A session id is minted by the runtime that holds it and means nothing on its
 * own — two runtimes can hold the same id, and the tasks bridge derives ids
 * from a task origin rather than from the machine — while parentage is
 * recorded only by the runtime that owns both sessions. So a row on another
 * machine naming this caller's id, or carrying it, is not evidence of
 * anything, and no store records that a session of one workspace started a
 * session of another. The account setting that lets a session write to other
 * machines therefore widens where work may be CREATED; it does not hand this
 * session authority over sessions already running there.
 */
import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import type { WorkspaceTarget } from "../client/contract"
import { McpAccessDenied, type McpToolContext } from "../context"
import { targetScope } from "./target"

/**
 * `own-children` leaves the caller's own session out: answering a question is
 * the one act a session must not perform on itself, since that is approving
 * its own work.
 */
export type SessionReach = "own-children" | "itself-or-own-children"

export type SessionReachInput = Readonly<{
  ctx: McpToolContext
  tool: string
  server: WorkspaceRuntimeClient
  target: WorkspaceTarget
  session: string
  reach: SessionReach
}>

export async function assertSessionReach(input: SessionReachInput): Promise<void> {
  const { credential } = input.ctx
  if (credential.kind !== "runtime") return
  const caller = credential.sessionId
  if (!caller) {
    throw new McpAccessDenied(
      "own-children-only",
      `${input.tool} acts on the session that called it, and this credential names no session`,
    )
  }
  const { workspaceId } = input.target
  if (workspaceId && workspaceId !== credential.workspaceId) {
    throw new McpAccessDenied(
      "own-children-only",
      `${input.tool} acts on the sessions of workspace ${credential.workspaceId}, where this session runs; nothing records that `
        + `session ${input.session} in ${workspaceId} belongs to it, so naming it is refused even where the account allows `
        + "this session to write to other machines",
    )
  }
  if (input.reach === "itself-or-own-children" && input.session === caller) return
  // A session this credential cannot read is one it cannot be the parent of:
  // the refusal is the same whether the runtime answered 404 or would not
  // answer at all.
  const stored = await input.server.session
    .get({ sessionID: input.session, ...targetScope(input.target) })
    .catch(() => undefined)
  if (stored?.data.parentID === caller) return
  throw new McpAccessDenied(
    "own-children-only",
    input.reach === "own-children"
      ? `Session ${input.session} is not a child of this session`
      : `Session ${input.session} is neither this session nor a child of it, so ${input.tool} cannot reach it`,
  )
}
