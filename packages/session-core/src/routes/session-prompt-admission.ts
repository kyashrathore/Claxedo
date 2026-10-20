import { HTTPException } from "hono/http-exception"
import type { RecoveryOutcome, AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "../host/contracts"
import { errorMessage } from "@claxedo/helpers"
import {
  AGENT_RUNTIME_MESSAGE_ID_CONFLICT_CODE,
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  isAgentRuntimeMessageIdConflictError,
  isAgentRuntimeTurnAdmissionError,
  type AgentRuntime,
} from "../host/runtime"
import {
  envelopeDirectory,
  runRuntimePromptTurn,
  type ActiveTurnScope,
  type SessionPromptBody,
  type SessionPromptTurnResult,
} from "../session/service"
import type { QueuedPromptRequester, SessionDeliveryOwner } from "../session/delivery-owner"
import { settleSessionTurn } from "./session-lifecycle"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionRequestProvenance,
  type SessionTurnGrantDecision,
} from "../session-access-policy"
import { errorBody } from "./error-body"
import { harnessUnavailableResponse } from "./session-harness-refusal"
import { sessionOperationGuard } from "./session-operation-guard"
import { rejectPermissionOverride } from "./session-permission-ceiling"
import {
  after,
  managedSessionLifecycle,
  readSession,
  recordReaderSend,
  requestTurnSender,
  type SessionRouteContext as Ctx,
  type SessionRouteOptions as Opts,
} from "./session-route-options"
import { acquireSessionTurnLease, type ActiveSessionTurnLease } from "./session-turn-lease"
import { captureTurnTarget, containLostTurn, recoveryCaller } from "./session-turn-containment"
import { sessionError, withDir } from "../projection/presentation-events"

/**
 * A headline for a turn/stream failure that keeps the cause: the real message
 * is what `sessionError` → `firstTurnErrorData` classifies (unmatched →
 * "unknown") and what the client's raw-detail disclosure shows.
 */
function streamTurnErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Stream error"
}

export function publishTurnFailure(
  publishGlobal: (event: AgentEventEnvelope) => void,
  directory: RuntimeDirectory,
  sessionId: string,
  error: unknown,
) {
  publishGlobal(withDir(envelopeDirectory(directory, sessionId), sessionError(streamTurnErrorMessage(error), sessionId)))
}

export async function settleChildTurn(opts: Opts, sessionId: string, directory: RuntimeDirectory, turnId: string | undefined) {
  if (!turnId) return
  try {
    await opts.childSessions?.onTurnSettled(sessionId, directory, turnId)
  } catch (error) {
    console.error(`child session bookkeeping for ${sessionId} failed`, error)
  }
}

export async function settleTurnLifecycle(opts: Opts, sessionId: string) {
  await settleSessionTurn(opts.sessionLifecycle, sessionId)
}

export function messageIdConflict(c: Ctx) {
  return c.json(errorBody(AGENT_RUNTIME_MESSAGE_ID_CONFLICT_CODE, "Message id is already used by another session"), 409)
}

export function turnAdmissionConflict(c: Ctx) {
  return c.json({
    ok: false,
    error: {
      code: AGENT_RUNTIME_TURN_CONFLICT_CODE,
      message: "Session is already processing a turn",
    },
  }, 409)
}

/**
 * A turn's answer lands before its route checkpoints and releases the lease,
 * and the authority refuses another turn's acquire until then, so a prompt
 * sent in that gap waits out the release instead of failing with
 * session_turn_in_progress. A session still running a turn is not waited on.
 */
async function awaitReleaseOfEndedTurn(input: { opts: Opts; c: Ctx; directory: RuntimeDirectory; sessionId: string }) {
  const held = input.opts.heldTurnLeases
  if (!held?.holds(input.sessionId)) return
  const status = (await readSession(input.opts, input.c, input.directory, input.sessionId))?.status
  if (status === "busy" || status === "retry") return
  await held.released(input.sessionId)
}

/**
 * A prompt's authorization and, for a relay-replayed caller on a managed
 * policy, its durable admission in the same decision: acquiring the lease is
 * the authority's `agent_turn` answer for the actor, so the authority is asked
 * once where a separate `prompt` question would ask it twice. A machine's own
 * user, and a caller on a policy that admits no turns, is answered by the
 * policy's `prompt` question alone. Before the decision the session is read
 * for one thing, whether a lease this host holds on it is being released,
 * which only delays the decision; everything a refused caller could learn
 * from the session stays behind it.
 */
export async function admitPromptTurn(input: {
  opts: Opts
  c: Ctx
  directory: RuntimeDirectory
  sessionId: string
  turnId?: string
  onLost: () => Promise<RecoveryOutcome> | RecoveryOutcome
}): Promise<{ lease?: ActiveSessionTurnLease; rejected?: Response }> {
  if (!managedSessionLifecycle(input.opts, input.c)) {
    const refused = await sessionOperationGuard(input.opts, input.c, input.sessionId, "prompt")
    return refused ? { rejected: refused } : {}
  }
  if (!input.turnId) {
    return {
      rejected: Response.json(errorBody(
        "session_turn_id_required",
        "Managed prompts require a stable messageID before runtime mutation",
      ), { status: 400 }),
    }
  }
  await awaitReleaseOfEndedTurn(input)
  const acquired = await acquireSessionTurnLease({
    policy: input.opts.sessionAccessPolicy!,
    access: {
      ...sessionAccessContext(input.c),
      operation: "prompt",
      sessionId: input.sessionId,
      method: input.c.req.method,
      path: input.c.req.path,
    },
    turnId: input.turnId,
    onLost: input.onLost,
    ...(input.opts.heldTurnLeases ? { held: input.opts.heldTurnLeases } : {}),
  })
  if (!acquired.acquired) return { rejected: sessionAccessDenied(acquired.decision) }
  const refused = await input.opts.beforeSessionOperation?.(input.c, { sessionId: input.sessionId, operation: "prompt" })
  if (refused) {
    await acquired.lease.release().catch(() => undefined)
    return { rejected: refused }
  }
  return { lease: acquired.lease }
}

export function turnScope(base: ActiveTurnScope | undefined, lease: ActiveSessionTurnLease | undefined): ActiveTurnScope | undefined {
  if (!lease) return base
  return {
    signal: base?.signal ? AbortSignal.any([base.signal, lease.signal]) : lease.signal,
    ...(base?.dispose ? { dispose: base.dispose } : {}),
  }
}

type DeferredTurnGrantRequest = { sessionId: string } & (
  | { intent: "child_completion"; subjectSessionId: string; registrationOperationId?: string }
  | { intent: "queued_prompt"; turnId: string }
)

/**
 * Mints the proof a turn the runtime later starts for itself will present:
 * a completion wake on `sessionId`, or a queued prompt on it. The plane
 * proves `agent_turn` for this request's actor now; the turn has no
 * credential of its own later, and the actor it was recorded under is a claim
 * the plane refuses as proof.
 *
 * Nothing is minted for a loopback request — the machine's own user takes no
 * lease — or on a policy that mints none, where the turn re-authorizes the
 * stored origin instead. A mint the plane refuses or that throws is one
 * outcome: this request could have proven the turn and the turn will not be
 * able to, so the caller writes nothing durable for it.
 */
export async function deferredTurnGrant(opts: Opts, c: Ctx, request: DeferredTurnGrantRequest): Promise<{ grant?: string } | { refused: string }> {
  const policy = opts.sessionAccessPolicy
  if (sessionRequestProvenance(c) !== "relay-replayed" || !policy?.grantTurn) return {}
  let decision: SessionTurnGrantDecision
  try {
    decision = await policy.grantTurn({
      ...sessionAccessContext(c),
      operation: "prompt",
      ...request,
      method: c.req.method,
      path: c.req.path,
    })
  } catch (error) {
    return { refused: errorMessage(error) }
  }
  return decision.allowed ? { grant: decision.grant } : { refused: decision.message }
}

/** A refused mint answers 503 whatever the plane's own status: the create or the queue is what could not be completed. */
export function deferredTurnGrantRefused(code: string, message: string) {
  return new HTTPException(503, { message, res: Response.json(errorBody(code, message), { status: 503 }) })
}

/**
 * What the durable queue records about the requester, the grant included when
 * the plane mints one for the message id the row is queued under.
 */
export async function queuedPromptRequester(
  opts: Opts,
  c: Ctx,
  sessionId: string,
  messageID: string,
): Promise<QueuedPromptRequester | { refused: Response }> {
  const access = sessionAccessContext(c)
  const granted = await deferredTurnGrant(opts, c, { sessionId, intent: "queued_prompt", turnId: messageID })
  if ("refused" in granted) {
    return { refused: c.json(errorBody("queued_prompt_grant_refused", `Session ${sessionId} did not grant the queued turn ${messageID}: ${granted.refused}`), 503) }
  }
  return {
    actor: access.actor,
    author: access.author,
    authority: access.authority,
    provenance: sessionRequestProvenance(c),
    ...(granted.grant ? { grant: granted.grant } : {}),
  }
}

type SteerResult = Awaited<ReturnType<SessionDeliveryOwner["steer"]>>

/**
 * A prompt sent for queued or steered delivery, recorded with its requester.
 * It is the sender's send now; the turn that later delivers it is the
 * runtime's own and records none.
 */
export async function admitQueuedDelivery(
  opts: Opts,
  c: Ctx,
  runtime: AgentRuntime,
  input: { sessionId: string; body: SessionPromptBody & { messageID: string; delivery: "queue" | "steer" } },
): Promise<{ refused: Response } | { queued: true } | { steered: SteerResult }> {
  const { sessionId, body } = input
  if (!opts.queuedPrompts) return { refused: c.json({ error: "Queued delivery requires a durable runtime owner" }, 409) }
  const requester = await queuedPromptRequester(opts, c, sessionId, body.messageID)
  if ("refused" in requester) return requester
  const submission = { sessionId, body, ...requester }
  if (body.delivery === "queue") {
    opts.queuedPrompts.queue(submission)
    await recordReaderSend(runtime, c, sessionId)
    return { queued: true }
  }
  const steered = await opts.queuedPrompts.steer(submission)
  if (steered.ok || steered.status === "pending" || steered.status === "unknown") await recordReaderSend(runtime, c, sessionId)
  return { steered }
}

/** A steer the runtime has not refused stands; only a refusal is a conflict. */
export function steerAnswerStatus(steered: Exclude<SteerResult, { ok: true }>) {
  return steered.status === "pending" || steered.status === "unknown" ? 202 : 409
}

type PromptAdmission = { answer: Response; turn?: Promise<void>; failed?: { error: unknown } }

/**
 * `prompt_async`'s admission, which a create's first prompt goes through too,
 * and the caller's authorization with it: a turn it starts is authorized by
 * its lease (`admitPromptTurn`), and a queued delivery or a resend by the
 * policy's `prompt` answer, each ahead of any read of the session it answers
 * from. A prompt is deduplicated by message id and nothing more: the
 * per-session concurrency lease is the runtime host's. The checkpoint-freeze
 * middleware runs before these routes, so a 423 may preempt admission
 * entirely. A live entry is the owning request's pending answer: a resend that
 * finds one joins it instead of admitting the same prompt twice. A resend this
 * instance holds no entry for, after a restart or an evicted object, is
 * answered from what the session durably holds under that id, its transcript
 * or its queue, so a client whose answer was lost can send the same message
 * again and it runs once.
 */
export function createPromptAdmission(opts: Opts, requestErrorResponse: (err: unknown, c: Ctx) => Response) {
  /** A live entry's answer, or nothing once the request that opened it was refused before admitting anything: a joiner then admits for itself. */
  const promptAdmissions = new Map<string, Map<string, Promise<Response | undefined>>>()
  const releasePromptAdmission = (sessionId: string, messageId: string | undefined) => {
    if (!messageId) return
    const admitted = promptAdmissions.get(sessionId)
    if (!admitted?.delete(messageId)) return
    if (admitted.size === 0) promptAdmissions.delete(sessionId)
  }
  const ADMISSION_ACK_TIMED_OUT = Symbol("prompt-async-admission-timeout")
  // Wait for the turn's admission decision, but never longer than the bound: a
  // turns.start whose harness launch neither admits the turn nor throws must not
  // hang the prompt_async response. On timeout the caller gets its
  // fire-and-forget 204 and the detached turn continues; a conflict or error
  // then surfaces on the event stream.
  const awaitAdmissionAck = async (admission: Promise<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof ADMISSION_ACK_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(ADMISSION_ACK_TIMED_OUT), opts.promptAsyncAdmissionAckTimeoutMs ?? 5_000)
    })
    try {
      return await Promise.race([admission, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  /**
   * `failed` is a runtime that refused the turn within the bound, and nothing
   * has published it: the caller answers it. prompt_async publishes it and
   * still answers 204; a create undoes the session instead, and waits out
   * `turn` before undoing anything the turn's own cleanup still writes to.
   */
  return async (
    c: Ctx,
    input: { sessionId: string; directory: RuntimeDirectory; body: SessionPromptBody },
  ): Promise<PromptAdmission> => {
    const { sessionId: id, directory } = input
    let body = input.body
    // The ceiling's refusal names the session's modes, so it waits for the caller's authorization.
    const prepare = async () => {
      body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body }) ?? body
      return rejectPermissionOverride(opts, c, directory, id, body.permissionMode)
    }
    const guard = () => sessionOperationGuard(opts, c, id, "prompt")
    let settleAdmissionAnswer: ((response: Response | undefined) => void) | undefined
    if (body.messageID) {
      // A stored answer is the session's; the policy's `prompt` answer stands
      // ahead of it for a joiner as it does for a resend of a held message.
      const pending = promptAdmissions.get(id)?.get(body.messageID)
      if (pending) {
        const refused = await guard()
        if (refused) return { answer: refused }
        const answer = await pending
        if (answer) return { answer: answer.clone() }
      }
      const admissions = promptAdmissions.get(id) ?? new Map<string, Promise<Response | undefined>>()
      admissions.set(body.messageID, new Promise<Response | undefined>((resolve) => {
        settleAdmissionAnswer = resolve
      }))
      promptAdmissions.set(id, admissions)
    }
    // A stored answer outlives its request, so it must not survive a
    // failure that happens before the harness is asked to run anything:
    // the retry that arrives once the cause is gone would join the stale
    // failure and the turn would never run.
    let admittedForExecution = false
    let turn: Promise<void> | undefined
    let failed: { error: unknown } | undefined
    // The runtime is resolved only for an authorized caller: on a machine,
    // resolving it may apply the session's configuration and build an engine.
    const admit = async (): Promise<Response> => {
      const held = body.messageID ? opts.queuedPrompts?.heldDelivery(id, body.messageID) : undefined
      if (held) {
        const refused = await guard()
        if (refused) return refused
        admittedForExecution = true
        return held === "start" ? c.body(null, 204) : c.json({ delivery: held })
      }
      body.messageID ??= `msg_${crypto.randomUUID()}`
      if (body.delivery) {
        const refused = await guard() ?? await prepare()
        if (refused) return refused
        const delivery = body.delivery
        let delivered: Awaited<ReturnType<typeof admitQueuedDelivery>>
        try { delivered = await admitQueuedDelivery(opts, c, await opts.runtime(c), { sessionId: id, body: { ...body, messageID: body.messageID, delivery } }) }
        catch (error) {
          if (isAgentRuntimeMessageIdConflictError(error)) return messageIdConflict(c)
          if (delivery === "queue") return c.json({ error: streamTurnErrorMessage(error) }, 503)
          throw error
        }
        if ("refused" in delivered) return delivered.refused
        admittedForExecution = true
        if ("queued" in delivered) return c.json({ delivery: "queue" })
        if (delivered.steered.ok) return c.json({ delivery: "steer" })
        return c.json({ ...delivered.steered, error: delivered.steered.message }, steerAnswerStatus(delivered.steered))
      }
      const lostTurn = captureTurnTarget((target) => opts.childSessions?.onTurnStarted(id, directory, target.turnId))
      const turnAdmission = await admitPromptTurn({
        opts,
        c,
        directory,
        sessionId: id,
        turnId: body.messageID,
        onLost: async () => containLostTurn({ runtime: (await opts.runtime(c)).recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
      })
      if (turnAdmission.rejected) return turnAdmission.rejected
      const unprepared = await readSession(opts, c, directory, id)
        ? await prepare()
        : c.json(errorBody("session_not_found", "Session not found"), 404)
      if (unprepared) {
        await turnAdmission.lease?.release().catch(() => undefined)
        return unprepared
      }
      const runtime = await opts.runtime(c)
      let settleAdmission: ((error?: unknown) => void) | undefined
      const admission = new Promise<unknown>((resolve) => {
        settleAdmission = resolve
      })
      const runTurn: () => Promise<SessionPromptTurnResult> = () => runRuntimePromptTurn({
        runtime,
        sessionId: id,
        directory,
        body,
        ...requestTurnSender(c),
        publishGlobal: opts.publishGlobal,
        createActiveTurnScope: opts.createActiveTurnScope
          ? () => turnScope(opts.createActiveTurnScope?.({ c, directory, sessionId: id }), turnAdmission.lease)
          : undefined,
        ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
        streamErrorMessage: streamTurnErrorMessage,
        onTurnTarget: lostTurn.set,
        onAdmissionSettled: settleAdmission,
      })
      // The turn runs detached: the response must not wait for the model.
      admittedForExecution = true
      const admissionAck = awaitAdmissionAck(admission)
      turn = (async () => {
        try {
          const finished = await runTurn()
          if (!turnAdmission.lease?.lost()) {
            await after(opts.afterMessageCheckpoint?.(c, directory, id, finished.messages))
          }
        } catch (error) {
          settleAdmission?.(error)
          if (isAgentRuntimeTurnAdmissionError(error)) return
          if (await admissionAck === error) return
          publishTurnFailure(opts.publishGlobal, directory, id, error)
        } finally {
          const leaseLost = turnAdmission.lease?.lost() ?? false
          if (!leaseLost) {
            await settleTurnLifecycle(opts, id)
            if (opts.afterMessageCheckpoint) {
              await after(opts.afterMessageCheckpoint(c, directory, id, await runtime.events.list(id, directory)))
            }
          }
          await turnAdmission.lease?.release().catch(() => undefined)
          await settleChildTurn(opts, id, directory, lostTurn.get()?.turnId)
        }
      })()
      const admissionError = await admissionAck
      // Admission did not settle within the bound — honor prompt_async's
      // fire-and-forget contract rather than block on a wedged turn.
      if (admissionError === ADMISSION_ACK_TIMED_OUT) return c.body(null, 204)
      if (isAgentRuntimeTurnAdmissionError(admissionError)) {
        releasePromptAdmission(id, body.messageID)
        return turnAdmissionConflict(c)
      }
      if (isAgentRuntimeMessageIdConflictError(admissionError)) {
        releasePromptAdmission(id, body.messageID)
        return messageIdConflict(c)
      }
      const refused = harnessUnavailableResponse(c, admissionError)
      if (refused) {
        releasePromptAdmission(id, body.messageID)
        return refused
      }
      if (admissionError !== undefined) failed = { error: admissionError }
      return c.body(null, 204)
    }
    try {
      const answer = await admit()
      settleAdmissionAnswer?.(answer.status === 401 || answer.status === 403 ? undefined : answer.clone())
      return { answer, ...(turn ? { turn } : {}), ...(failed ? { failed } : {}) }
    } catch (error) {
      settleAdmissionAnswer?.(requestErrorResponse(error, c))
      throw error
    } finally {
      if (!admittedForExecution) releasePromptAdmission(id, body.messageID)
    }
  }
}
