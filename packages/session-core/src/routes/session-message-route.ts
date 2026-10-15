import { routeParam } from "@claxedo/helpers/route-param"
import { isAgentRuntimeMessageIdConflictError } from "../host/runtime"
import { messageUpdated, withDir } from "../projection/presentation-events"
import { parseSessionPromptBody, runRuntimePromptTurn, sessionPromptReply } from "../session/service"
import { errorBody } from "./error-body"
import { boundedJsonBody } from "./http"
import { sessionOperationGuard } from "./session-operation-guard"
import { rejectPermissionOverride } from "./session-permission-ceiling"
import {
  acquireManagedPromptLease,
  admitQueuedDelivery,
  flushDocumentsAfterTurn,
  messageIdConflict,
  settleChildTurn,
  steerAnswerStatus,
  turnScope,
} from "./session-prompt-admission"
import { after, readSession, requestTurnSender, type SessionRouteContext as Ctx, type SessionRouteOptions as Opts } from "./session-route-options"
import type { ActiveSessionTurnLease } from "./session-turn-lease"
import { captureTurnTarget, containLostTurn, recoveryCaller } from "./session-turn-containment"

/**
 * The revoked caller's answer, carrying what containment reached for the turn
 * it lost. That result is the lease's alone until this point: the caller is
 * the one owed it, and it names an operation the runtime's own inspection
 * then reports for as long as it stays unresolved.
 */
function lostTurnResponse(sessionId: string, lease?: ActiveSessionTurnLease) {
  const loss = lease?.lossResult()
  return Response.json(errorBody(
    "session_turn_lease_lost",
    `Session ${sessionId} turn authority was lost before completion`,
    loss ? { containment: loss } : undefined,
  ), { status: 409 })
}

/** `POST /session/:id/message`: a prompt answered with the turn it ran, once that turn ends. */
export async function sessionMessageRoute(opts: Opts, c: Ctx): Promise<Response> {
  const id = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, id, "prompt")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId: id })
  if (!await readSession(opts, c, directory, id)) return c.json(errorBody("session_not_found", "Session not found"), 404)
  const runtime = await opts.runtime(c)
  const parsedBody = parseSessionPromptBody(await boundedJsonBody(c))
  const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: parsedBody }) ?? parsedBody
  const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, body.permissionMode)
  if (permissionRefusal) return permissionRefusal
  if (body.delivery) {
    const messageID = body.messageID ?? `msg_${crypto.randomUUID()}`
    const delivered = await admitQueuedDelivery(opts, c, runtime, { sessionId: id, body: { ...body, messageID, delivery: body.delivery } })
    if ("refused" in delivered) return delivered.refused
    if ("queued" in delivered) return c.json({ delivery: "queue", messageID }, 202)
    if (delivered.steered.ok) return c.json({ delivery: "steer", messageID })
    return c.json({ ...delivered.steered, error: delivered.steered.message }, steerAnswerStatus(delivered.steered))
  }
  const lostTurn = captureTurnTarget((target) => opts.childSessions?.onTurnStarted(id, directory, target.turnId))
  const turnAdmission = await acquireManagedPromptLease({
    opts,
    c,
    directory,
    sessionId: id,
    turnId: body.messageID,
    onLost: () => containLostTurn({ runtime: runtime.recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
  })
  if (turnAdmission.rejected) return turnAdmission.rejected
  const lease = turnAdmission.lease
  const activeTurn = opts.createActiveTurnScope
    ? turnScope(opts.createActiveTurnScope({ c, directory, sessionId: id }), lease)
    : undefined
  const leaseGone = () => !!lease && (lease.lost() || !lease.valid())
  try {
    const turn = await (async () => {
      try {
        return await runRuntimePromptTurn({
          runtime,
          sessionId: id,
          directory,
          body,
          ...requestTurnSender(c),
          publishGlobal: opts.publishGlobal,
          activeTurn,
          onTurnTarget: lostTurn.set,
          ...(lease ? { turnAdmission: lease } : {}),
        })
      } finally {
        if (!lease?.lost()) await flushDocumentsAfterTurn(opts, id)
        await settleChildTurn(opts, id, directory, lostTurn.get()?.turnId)
      }
    })()
    if (leaseGone()) return lostTurnResponse(id, lease)
    await after(opts.afterMessageCheckpoint?.(c, directory, id, turn.messages))
    if (leaseGone()) return lostTurnResponse(id, lease)
    const output = sessionPromptReply(turn)
    if (output.assistantMessage) opts.publishGlobal(withDir(turn.scope, messageUpdated(output.assistantMessage)))
    return c.json(output.body)
  } catch (error) {
    if (lease?.lost()) return lostTurnResponse(id, lease)
    if (isAgentRuntimeMessageIdConflictError(error)) return messageIdConflict(c)
    throw error
  } finally {
    await lease?.release().catch(() => undefined)
  }
}
