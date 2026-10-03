import { HTTPException } from "hono/http-exception"
import { routeParam } from "@claxedo/helpers/route-param"
import type { RuntimeDirectory } from "../host/contracts"
import type { AgentRuntime } from "../host/runtime"
import type { SessionTreeEntry } from "../host/session-tree-hold"
import { sessionDeleted, withDir } from "../projection/presentation-events"
import { envelopeDirectory } from "../session/service"
import { errorBody } from "./error-body"
import { sessionOperationGuard } from "./session-operation-guard"
import { requestSecretAuthority, type SessionRouteContext as Ctx, type SessionRouteOptions as Opts } from "./session-route-options"

export type SessionChange = <T>(sessionId: string, change: () => Promise<T>) => Promise<T>

const REFUSALS = {
  owned_by_parent: "runs on its parent's harness and is deleted with its parent",
  working: "is working",
  awaiting_input: "is waiting for input",
  held: "is held by another operation",
} as const

/**
 * `DELETE /session/:id`: the session and every descendant are held idle and
 * claimed against a concurrent create or delete for the whole removal, which
 * runs leaf-first so a failure never leaves a child without its parent. The
 * first hook that fails ends it, and the answer names what was removed.
 */
export async function sessionDeleteRoute(opts: Opts, c: Ctx, withSessionChange: SessionChange): Promise<Response> {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
  if (guarded) return guarded
  return withSessionChange(sessionId, async () => {
    const directory = await opts.resolveDirectory(c, { sessionId })
    const runtime = await opts.runtime(c)
    const tree = await runtime.sessions.holdTree(sessionId)
    if (!tree.held) {
      if (tree.reason === "not_found") return c.json(errorBody("session_not_found", "Session not found"), 404)
      return c.json(errorBody("session_delete_refused", `Session ${tree.sessionId} ${REFUSALS[tree.reason]}`, {
        sessionId: tree.sessionId, reason: tree.reason,
      }), 409)
    }
    try {
      const descendants = tree.leafFirst.flatMap((entry) => entry.sessionId === sessionId ? [] : [entry.sessionId])
      return await withSessionChanges(descendants, withSessionChange, () => removeLeafFirst(opts, c, runtime, directory, tree.leafFirst))
    } finally {
      tree.release()
    }
  })
}

function withSessionChanges<T>(sessionIds: readonly string[], withSessionChange: SessionChange, operation: () => Promise<T>): Promise<T> {
  const [first, ...rest] = sessionIds
  return first === undefined ? operation() : withSessionChange(first, () => withSessionChanges(rest, withSessionChange, operation))
}

async function removeLeafFirst(
  opts: Opts,
  c: Ctx,
  runtime: AgentRuntime,
  directory: RuntimeDirectory,
  leafFirst: readonly SessionTreeEntry[],
): Promise<Response> {
  const deletedSessionIds: string[] = []
  for (const { sessionId, parentSessionId } of leafFirst) {
    try {
      const start = opts.sessionStarts?.get(sessionId)?.binding
      await opts.beforeDeleteSession?.(c, directory, sessionId)
      await opts.disposeSessionDocuments?.(sessionId)
      await runtime.sessions.delete(sessionId, directory, requestSecretAuthority(c).secretAuthority)
      // A deletion that got this far removed the session the creation owns, so
      // the id goes back. A failure above keeps the owner, which is what lets a
      // caller distinguish a freed id from a half-deleted one.
      if (start) opts.sessionStarts!.retire(start)
      opts.publishGlobal(withDir(envelopeDirectory(directory, sessionId), sessionDeleted(sessionId, directory ?? "", parentSessionId)))
      deletedSessionIds.push(sessionId)
    } catch (error) {
      return c.json(errorBody("session_delete_failed", error instanceof Error ? error.message : String(error), {
        sessionId, deletedSessionIds,
      }), error instanceof HTTPException ? error.status : 500)
    }
  }
  return c.json({ ok: true, deletedSessionIds })
}
