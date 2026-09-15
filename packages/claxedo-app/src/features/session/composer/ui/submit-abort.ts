import type { Accessor } from "solid-js"
import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { setPromptSessionStatus, takePendingPrompt } from "../../submit/index"
import { dispatchSessionRequestsEvent, dispatchSessionTodoEvent } from "../../store/session-status-dispatcher"
import { upsertDirectorySession } from "../../data/sync/directory-session-cache"
import type { ClaxedoSession } from "../../data/session-types"
import type { PermissionRequest, QuestionRequest, SessionRequestsQueryData, SessionStatus } from "../../data/sync/queries"

type SessionRequestState = SessionRequestsQueryData
type SessionRequestItem = (PermissionRequest | QuestionRequest) & { sessionID?: string }

type AbortClient = {
  session: {
    abort(input: { sessionID: string; directory: string; turnId?: string }): Promise<Pick<Awaited<ReturnType<WorkspaceRuntimeClient["session"]["abort"]>>, "data">>
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

    // Stop's only feedback until the runtime answers, and the reconcile below
    // is not a bound on that: `/session/status` can be held open or never
    // answer at all, so a control that waits for it stays on "stop" through a
    // cancel the user already made.
    setPromptSessionStatus({ sessionID, status: { type: "idle" }, source: "optimistic" })
    dispatchSessionTodoEvent({ event: { type: "session.todo", source: "optimistic", sessionID, todos: [] } })

    const queued = takePendingPrompt(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      return Promise.resolve()
    }
    // Stop names the turn this composer started, so a request that lands after
    // that turn ended cannot cancel the one that replaced it. A turn this
    // composer did not start has no id to name, and cancels whatever is running.
    const turnId = input.turnId?.()
    const result = await client.session.abort({ sessionID, directory, ...(turnId ? { turnId } : {}) })
    if (!result.data) throw new Error("Stop returned no cancellation result")
    if (!result.data.ok) throw new Error(result.data.message)
    // The turn is already cancelled; these reads only reconcile what it left
    // behind, so one of them failing is not a Stop that failed.
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
  stopFailedTitle: () => string
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
        input.showToast({ title: input.stopFailedTitle(), description: input.errorMessage(err), variant: "error" })
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
