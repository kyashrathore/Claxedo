import { randomUUID } from "node:crypto"
import { HTTPException } from "hono/http-exception"
import type { RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import { errorMessage } from "@claxedo/helpers"
import { asRecord } from "@claxedo/helpers/guards"
import {
  AGENT_RUNTIME_MESSAGE_ID_CONFLICT_CODE,
  AGENT_RUNTIME_TURN_CONFLICT_CODE,
  isAgentRuntimeMessageIdConflictError,
  isAgentRuntimeTurnAdmissionError,
} from "../host/runtime"
import { sessionError, withDir, type CompatEnvelope } from "../compat-events"
import {
  compatScope,
  runRuntimePromptTurn,
  type ActiveTurnScope,
  type SessionPromptBody,
  type SessionPromptTurnResult,
} from "../session/service"
import type { QueuedPromptRequester } from "../session/delivery-owner"
import {
  sessionAccessContext,
  sessionAccessDenied,
  sessionRequestProvenance,
  sessionTurnOrigin,
  type SessionTurnGrantDecision,
} from "../session-access-policy"
import { flushRuntimeSessionDocuments } from "./document-hydration"
import { errorBody } from "./error-body"
import { harnessUnavailableResponse } from "./session-harness-refusal"
import { rejectPermissionOverride } from "./session-permission-ceiling"
import {
  after,
  managedSessionLifecycle,
  readSession,
  turnOriginOf,
  type SessionRouteContext as Ctx,
  type SessionRouteOptions as Opts,
} from "./session-route-options"
import { acquireSessionTurnLease, type ActiveSessionTurnLease } from "./session-turn-lease"
import { captureTurnTarget, containLostTurn, recoveryCaller } from "./session-turn-containment"

/**
 * A headline for a turn/stream failure that keeps the cause: the real message
 * is what `sessionError` → `firstTurnErrorData` classifies (unmatched →
 * "unknown") and what the client's raw-detail disclosure shows.
 */
export function streamTurnErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Stream error"
}

export function publishTurnFailure(
  publishGlobal: (event: CompatEnvelope) => void,
  directory: RuntimeDirectory,
  sessionId: string,
  error: unknown,
) {
  publishGlobal(withDir(compatScope(directory, sessionId), sessionError(streamTurnErrorMessage(error), sessionId)))
}

export async function settleChildTurn(opts: Opts, sessionId: string, directory: RuntimeDirectory) {
  try {
    await opts.childSessions?.onTurnSettled(sessionId, directory)
  } catch (error) {
    console.error(`child session bookkeeping for ${sessionId} failed`, error)
  }
}

export async function flushDocumentsAfterTurn(opts: Opts, sessionId: string) {
  try {
    await (opts.flushSessionDocuments ?? flushRuntimeSessionDocuments)(sessionId)
  } catch (error) {
    console.error(`[runtime-document] end-of-turn write-back failed for ${sessionId}:`, error)
  }
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

export async function acquireManagedPromptLease(input: {
  opts: Opts
  c: Ctx
  sessionId: string
  turnId?: string
  onLost: () => Promise<RecoveryOutcome> | RecoveryOutcome
}): Promise<{ lease?: ActiveSessionTurnLease; rejected?: Response }> {
  if (!managedSessionLifecycle(input.opts, input.c)) return {}
  if (!input.turnId) {
    return {
      rejected: Response.json(errorBody(
        "session_turn_id_required",
        "Managed prompts require a stable messageID before runtime mutation",
      ), { status: 400 }),
    }
  }
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
  })
  if (!acquired.acquired) return { rejected: sessionAccessDenied(acquired.decision) }
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

export type PromptAdmission = { answer: Response; turn?: Promise<void>; failed?: { error: unknown } }

/**
 * `prompt_async`'s admission, which a create's first prompt goes through too.
 * Retries are deduplicated by message id and nothing more: the per-session
 * concurrency lease is the runtime host's. The checkpoint-freeze middleware
 * runs before these routes, so a 423 may preempt admission entirely. A live
 * entry is the owning request's pending answer: a retry that finds one joins
 * it instead of deduplicating on sight or admitting the same prompt twice.
 */
export function createPromptAdmission(opts: Opts, requestErrorResponse: (err: unknown, c: Ctx) => Response) {
  const promptAdmissions = new Map<string, Map<string, Promise<Response>>>()
  const releasePromptAdmission = (sessionId: string, messageId: string | undefined) => {
    if (!messageId) return
    const admitted = promptAdmissions.get(sessionId)
    if (!admitted?.delete(messageId)) return
    if (admitted.size === 0) promptAdmissions.delete(sessionId)
  }
  const ADMISSION_ACK_TIMED_OUT = Symbol("prompt-async-admission-timeout")
  // Wait for the turn's admission decision, but never longer than the bound:
  // a wedged turns.start (adapter spawn that never settles admission and never
  // throws) must not hang the prompt_async response. On timeout the caller gets
  // its fire-and-forget 204 and the detached turn continues; any conflict/error
  // then surfaces on the event stream.
  const awaitAdmissionAck = async (admission: Promise<unknown>): Promise<unknown> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof ADMISSION_ACK_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(ADMISSION_ACK_TIMED_OUT), opts.promptAsyncAdmissionAckTimeoutMs ?? 5_000)
      timer.unref?.()
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
    const body = await opts.transformPromptBody?.(c, { sessionId: id, directory, body: input.body }) ?? input.body
    const permissionRefusal = await rejectPermissionOverride(opts, c, directory, id, body.permissionMode)
    if (permissionRefusal) return { answer: permissionRefusal }
    let settleAdmissionAnswer: ((response: Response) => void) | undefined
    if (body.messageID) {
      const pending = promptAdmissions.get(id)?.get(body.messageID)
      if (pending) return { answer: (await pending).clone() }
      const admissions = promptAdmissions.get(id) ?? new Map<string, Promise<Response>>()
      admissions.set(body.messageID, new Promise<Response>((resolve) => {
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
    const admit = async (): Promise<Response> => {
      const runtime = await opts.runtime(c)
      if (body.messageID && c.req.header("x-claxedo-idempotency-retry") === "1") {
        const messages = await opts.getMessages?.(c, directory, id) ?? await runtime.events.list(id, directory)
        const projected = messages.some((message) => asRecord(message.info)?.id === body.messageID)
        const session = projected
          ? undefined
          : await readSession(opts, c, directory, id)
        if (
          projected
          || session?.status === "busy"
          || session?.status === "recovering"
          || session?.status === "retry"
        ) {
          admittedForExecution = true
          return c.body(null, 204)
        }
      }
      body.messageID ??= `msg_${randomUUID()}`
      const access = sessionAccessContext(c)
      if (body.delivery) {
        if (!opts.queuedPrompts) return c.json({ error: "Queued delivery requires a durable runtime owner" }, 409)
        const requester = await queuedPromptRequester(opts, c, id, body.messageID)
        if ("refused" in requester) return requester.refused
        const submission = { sessionId: id, body, ...requester }
        if (body.delivery === "queue") {
          try { opts.queuedPrompts.queue(submission) }
          catch (error) { return c.json({ error: streamTurnErrorMessage(error) }, 503) }
          admittedForExecution = true
          return c.json({ delivery: "queue" })
        }
        const result = await opts.queuedPrompts.steer(submission)
        admittedForExecution = true
        if (result.ok) return c.json({ delivery: "steer" })
        return c.json({ ...result, error: result.message }, result.status === "pending" || result.status === "unknown" ? 202 : 409)
      }
      const lostTurn = captureTurnTarget()
      const turnAdmission = await acquireManagedPromptLease({
        opts,
        c,
        sessionId: id,
        turnId: body.messageID,
        onLost: () => containLostTurn({ runtime: runtime.recovery, sessionId: id, target: lostTurn.get(), caller: recoveryCaller(c) }),
      })
      if (turnAdmission.rejected) return turnAdmission.rejected
      let settleAdmission: ((error?: unknown) => void) | undefined
      const admission = new Promise<unknown>((resolve) => {
        settleAdmission = resolve
      })
      const runTurn: () => Promise<SessionPromptTurnResult> = () => runRuntimePromptTurn({
        runtime,
        sessionId: id,
        directory,
        body,
        origin: turnOriginOf(sessionTurnOrigin(c), c),
        publishGlobal: opts.publishGlobal,
        createActiveTurnScope: opts.createActiveTurnScope
          ? () => turnScope(opts.createActiveTurnScope?.({ c, directory, sessionId: id }), turnAdmission.lease)
          : undefined,
        ...(turnAdmission.lease ? { turnAdmission: turnAdmission.lease } : {}),
        streamErrorMessage: streamTurnErrorMessage,
        onTurnTarget: lostTurn.set,
        onAdmissionSettled: settleAdmission,
        actor: access.actor,
        author: access.author,
      })
      await opts.childSessions?.onTurnStarted(id, directory)
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
            await flushDocumentsAfterTurn(opts, id)
            if (opts.afterMessageCheckpoint) {
              await after(opts.afterMessageCheckpoint(c, directory, id, await runtime.events.list(id, directory)))
            }
          }
          await turnAdmission.lease?.release().catch(() => undefined)
          await settleChildTurn(opts, id, directory)
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
      settleAdmissionAnswer?.(answer.clone())
      return { answer, ...(turn ? { turn } : {}), ...(failed ? { failed } : {}) }
    } catch (error) {
      settleAdmissionAnswer?.(requestErrorResponse(error, c))
      throw error
    } finally {
      if (!admittedForExecution) releasePromptAdmission(id, body.messageID)
    }
  }
}
