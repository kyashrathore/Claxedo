import type { Accessor } from "solid-js"
import { isRecoveryOutcome, turnStopped, type RecoveryOutcome, type RecoveryRequest, type RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { setPromptSessionStatus, takePendingPrompt } from "../../submit/index"
import {
  dispatchSessionRequestsEvent,
  failSessionRecoveryCommand,
  settleSessionRecoveryCommand,
  startSessionRecoveryCommand,
} from "../../store/session-status-dispatcher"
import { describeRecoveryOutcome, describeRecoveryUnreachable } from "../../ui/recovery-outcome-copy"
import type { RecoveryCopy } from "../../ui/recovery-outcome-copy"
import { upsertDirectorySession } from "../../data/sync/directory-session-cache"
import type { ClaxedoSession } from "../../data/session-types"
import type { PermissionRequest, QuestionRequest, SessionRequestsQueryData, SessionStatus } from "../../data/sync/queries"

type SessionRequestState = SessionRequestsQueryData
type SessionRequestItem = (PermissionRequest | QuestionRequest) & { sessionID?: string }

/**
 * The half of the runtime's recovery surface a Stop needs. The inspection
 * carries more than this, but the turn identity is the only part a client may
 * send back, so the rest has no reader here.
 */
export type SessionRecoveryClient = {
  session: {
    recovery: {
      inspect(input: { sessionID: string; directory?: string }): Promise<{ data: { target?: RecoveryTurnTarget } | RecoveryOutcome }>
      submit(input: { sessionID: string; directory?: string; request: RecoveryRequest }): Promise<{ data: RecoveryOutcome }>
    }
  }
}

type AbortClient = SessionRecoveryClient & {
  session: {
    status(): Promise<{ data?: Record<string, SessionStatus> }>
    get(input: { sessionID: string }): Promise<{ data?: ClaxedoSession }>
  }
  permission: {
    list(): Promise<{ data?: SessionRequestState["permissions"] }>
  }
  question: {
    list(): Promise<{ data?: SessionRequestState["questions"] }>
  }
}

/**
 * A Stop that did not stop the turn, carrying the reading that says why. The
 * message is the owner's own words when it gave any; a renderer with the
 * dictionary to hand shows the reading's copy instead.
 */
export class RecoveryCommandFailure extends Error {
  constructor(readonly copy: RecoveryCopy) {
    super(copy.ownerMessage ?? copy.reading)
    this.name = "RecoveryCommandFailure"
  }
}

/**
 * One request id per turn while its cancellation is in flight, so a user
 * clicking Stop twice joins the operation already running instead of opening a
 * second one against the same turn. A click after it settles mints a new id:
 * reusing the old one would read the finished attempt back rather than retry.
 */
const cancellingTurns = new Map<string, string>()

export type StopRunningTurnResult =
  | { cancelled: false }
  | { cancelled: true; outcome: RecoveryOutcome }

/**
 * Stop the turn the owner reports as admitted, under the identity it reports
 * it with. `expectedTurnId` is the turn this caller started: when the owner is
 * running a different one, the caller's turn is already over and cancelling
 * what replaced it would stop work nobody asked to stop. `cancelled: false`
 * therefore means there was nothing of this caller's to stop, which is not a
 * Stop that failed.
 *
 * `retryOf` makes the submission an explicit new attempt against the same
 * turn: a fresh request id so the owner runs it rather than reading the
 * finished one back, linked to the attempt it follows.
 */
export async function stopRunningTurn(input: {
  client: SessionRecoveryClient
  sessionID: string
  directory?: string
  expectedTurnId?: string
  retryOf?: { operationId: string; attempt: number }
}): Promise<StopRunningTurnResult> {
  const scope = input.directory === undefined ? {} : { directory: input.directory }
  const inspected = await input.client.session.recovery.inspect({ sessionID: input.sessionID, ...scope })
  // An owner that refused to answer has not said this session is idle, so the
  // refusal is the Stop's outcome rather than a quiet "nothing to do".
  if (isRecoveryOutcome(inspected.data)) return { cancelled: true, outcome: inspected.data }
  const target = inspected.data.target
  if (!target) return { cancelled: false }
  if (input.expectedTurnId && target.turnId !== input.expectedTurnId) return { cancelled: false }
  const key = `${target.sessionId}:${target.turnId}:${target.ownerGeneration}`
  const retry = input.retryOf
  const requestId = retry
    ? `composer-stop:${crypto.randomUUID()}`
    : cancellingTurns.get(key) ?? `composer-stop:${crypto.randomUUID()}`
  const attempt = retry ? retry.attempt + 1 : 1
  cancellingTurns.set(key, requestId)
  startSessionRecoveryCommand({ sessionID: input.sessionID, requestId, action: "cancel_turn", attempt })
  try {
    const submitted = await input.client.session.recovery.submit({
      sessionID: input.sessionID,
      ...scope,
      request: {
        requestId,
        action: "cancel_turn",
        target,
        scopeRevision: target.ownerGeneration,
        attempt,
        ...(retry ? { linkedOperationId: retry.operationId } : {}),
      },
    })
    settleSessionRecoveryCommand({ sessionID: input.sessionID, requestId, outcome: submitted.data })
    return { cancelled: true, outcome: submitted.data }
  } catch (error) {
    // The owner never answered, so there are no facts: the turn may still be
    // running. Recording the reach failure keeps the command visible and
    // retryable instead of leaving the user with a toast and no operation.
    failSessionRecoveryCommand({ sessionID: input.sessionID, requestId, message: stopReachMessage(error) })
    throw error
  } finally {
    cancellingTurns.delete(key)
  }
}

function stopReachMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Goal Stop is a provider mutation, not a local abort: a transport failure
 * means the Goal is STILL RUNNING, so the rejection must reach the user
 * instead of vanishing into the voided promise composer call sites use.
 *
 * A failed Stop must ALSO fall back to the local prompt abort. `hasActiveGoal()`
 * reads a cached Goal snapshot that can be stale (the Goal already finished, so
 * Stop answers `not_found`) and the mutation can simply fail — either way the
 * turn the user pressed Stop on is still running, and routing solely to Goal
 * Stop would leave the button dead. The rejection is still reported, so the user
 * learns the Goal itself was not stopped.
 */
export function createGoalAwareAbort(input: {
  hasActiveGoal?: () => boolean
  stopGoal?: () => void | Promise<unknown>
  promptAbort: () => Promise<unknown>
  onStopGoalError: (err: unknown) => void
}) {
  return async () => {
    const stopGoal = input.stopGoal
    if (!input.hasActiveGoal?.() || !stopGoal) return await input.promptAbort()
    try {
      await stopGoal()
    } catch (error) {
      input.onStopGoalError(error)
      await input.promptAbort()
    }
    return undefined
  }
}

/** Interaction docks must stop their own Goal before cancelling its pending turn. */
export async function stopSessionInteraction(input: {
  sessionId: string
  goal?: { sessionId: string; status: string } | null
  stopGoal?: () => Promise<unknown>
  abort: () => Promise<unknown>
}) {
  let stopFailure: unknown
  await createGoalAwareAbort({
    hasActiveGoal: () => input.goal?.sessionId === input.sessionId && input.goal.status === "active",
    stopGoal: input.stopGoal,
    promptAbort: input.abort,
    onStopGoalError: (error) => { stopFailure = error },
  })()
  // The dock owns a visible retryable error state rather than a toast.
  if (stopFailure) throw stopFailure
}

export function createPromptAbort(input: {
  canAbort?: Accessor<boolean>
  sessionID?: Accessor<string | undefined>
  sessionDirectory?: Accessor<string | undefined>
  defaultDirectory: string
  /** The turn this caller started, when it started one. */
  turnId?: Accessor<string | undefined>
  clientForDirectory: (directory: string) => AbortClient
}) {
  return async () => {
    if (input.canAbort?.() === false) return Promise.resolve()
    const sessionID = input.sessionID?.()
    if (!sessionID) return Promise.resolve()
    const directory = input.sessionDirectory?.() ?? input.defaultDirectory
    const client = input.clientForDirectory(directory)

    phCapture("prompt_aborted", { ...identityProps(), surface: "composer" })

    const queued = takePendingPrompt(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      return Promise.resolve()
    }
    // A turn this composer did not start has no id to check the owner's
    // against, and cancels whichever turn the owner reports.
    const expectedTurnId = input.turnId?.()
    const cancelled = await stopRunningTurn({
      client,
      sessionID,
      directory,
      ...(expectedTurnId ? { expectedTurnId } : {}),
    })
    if (cancelled.cancelled && !turnStopped(cancelled.outcome)) {
      throw new RecoveryCommandFailure(describeRecoveryOutcome(cancelled.outcome))
    }
    // Nothing here is the cancellation: these reads reconcile what the turn
    // left behind, so one of them failing is not a Stop that failed.
    await Promise.all([
      client.session.get({ sessionID }).then((x) => {
        // The runtime records the cancellation on the session row's `lastTurn`;
        // without this read the interrupted divider only appeared after reload.
        if (x.data) upsertDirectorySession(directory, x.data)
      }),
      client.session.status().then((x) => {
        setPromptSessionStatus({ sessionID, status: x.data?.[sessionID] ?? { type: "idle" }, source: "server" })
      }),
      Promise.all([client.permission.list(), client.question.list()]).then(([permissions, questions]) => {
        dispatchSessionRequestsEvent({
          event: { type: "session.requests", source: "server", sessionID, requests: {
            permissions: (permissions.data ?? []).filter((item: SessionRequestItem) => item.sessionID === sessionID),
            questions: (questions.data ?? []).filter((item: SessionRequestItem) => item.sessionID === sessionID),
          } },
        })
      }),
    ]).catch(() => {})
  }
}

/** The composer's full abort wiring: transport-aware prompt abort behind the Goal-aware gate. */
export function createSubmitAbort(input: Parameters<typeof createPromptAbort>[0] & {
  hasActiveGoal?: () => boolean
  stopGoal?: () => void | Promise<unknown>
  /** Resolves a reading's keys against the active locale; only the caller has the dictionary. */
  recoveryToast: (copy: RecoveryCopy) => { title: string; description: string }
  stopGoalFailedTitle: () => string
  errorMessage: (err: unknown) => string
  showToast: (toast: { title: string; description: string; variant: "error" }) => void
}) {
  const promptAbort = createPromptAbort(input)
  return createGoalAwareAbort({
    hasActiveGoal: input.hasActiveGoal,
    stopGoal: input.stopGoal,
    promptAbort: async () => {
      try {
        await promptAbort()
      } catch (err) {
        const copy = err instanceof RecoveryCommandFailure
          ? err.copy
          : describeRecoveryUnreachable(input.errorMessage(err))
        input.showToast({ ...input.recoveryToast(copy), variant: "error" })
      }
    },
    onStopGoalError: (err) => {
      input.showToast({
        title: input.stopGoalFailedTitle(),
        description: input.errorMessage(err),
        variant: "error",
      })
    },
  })
}
