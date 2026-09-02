import type { Accessor } from "solid-js"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"
import { setPromptSessionStatus, takePendingPrompt } from "../../submit/index"
import { dispatchSessionRequestsEvent, dispatchSessionTodoEvent } from "../../store/session-status-dispatcher"
import type { PermissionRequest, QuestionRequest, SessionRequestsQueryData, SessionStatus } from "../../data/sync/queries"

type SessionRequestState = SessionRequestsQueryData
type SessionRequestItem = (PermissionRequest | QuestionRequest) & { sessionID?: string }

type AbortClient = {
  session: {
    abort(input: { sessionID: string; directory: string }): Promise<unknown>
    status(): Promise<{ data?: Record<string, SessionStatus> }>
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
  }
}

export function createPromptAbort(input: {
  canAbort?: Accessor<boolean>
  sessionID?: Accessor<string | undefined>
  sessionDirectory?: Accessor<string | undefined>
  defaultDirectory: string
  clientForDirectory: (directory: string) => AbortClient
  usesSignedControlPlane: (directory: string) => boolean
}) {
  return async () => {
    if (input.canAbort?.() === false) return Promise.resolve()
    const sessionID = input.sessionID?.()
    if (!sessionID) return Promise.resolve()
    const directory = input.sessionDirectory?.() ?? input.defaultDirectory
    const client = input.clientForDirectory(directory)

    phCapture("prompt_aborted", { ...identityProps(), surface: "composer" })
    dispatchSessionTodoEvent({ event: { type: "session.todo", source: "server", sessionID, todos: [] } })
    setPromptSessionStatus({ sessionID, status: { type: "idle" }, source: "server" })

    const queued = takePendingPrompt(sessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      return Promise.resolve()
    }
    return client.session
      .abort({ sessionID, directory })
      .catch(() => {})
      .finally(() => {
        if (input.usesSignedControlPlane(directory)) {
          setPromptSessionStatus({ sessionID, status: { type: "idle" }, source: "server" })
          dispatchSessionRequestsEvent({ event: { type: "session.requests", source: "server", sessionID, requests: { permissions: [], questions: [] } } })
          return Promise.resolve()
        }
        return Promise.all([
          client.session
            .status()
            .then((x) => {
              const status = x.data?.[sessionID]
              setPromptSessionStatus({
                sessionID,
                status: status ?? { type: "idle" },
                source: "server",
              })
            })
            .catch(() => {}),
          Promise.all([
            client.permission.list().then((x) => x.data ?? []).catch(() => []),
            client.question.list().then((x) => x.data ?? []).catch(() => []),
          ]).then(([permissions, questions]) => {
            dispatchSessionRequestsEvent({
              event: { type: "session.requests", source: "server", sessionID, requests: {
                permissions: permissions.filter((item: SessionRequestItem) => item.sessionID === sessionID),
                questions: questions.filter((item: SessionRequestItem) => item.sessionID === sessionID),
              } },
            })
          }),
        ])
      })
  }
}

/** The composer's full abort wiring: transport-aware prompt abort behind the Goal-aware gate. */
export function createSubmitAbort(input: Parameters<typeof createPromptAbort>[0] & {
  hasActiveGoal?: () => boolean
  stopGoal?: () => void | Promise<unknown>
  stopGoalFailedTitle: () => string
  errorMessage: (err: unknown) => string
  showToast: (toast: { title: string; description: string; variant: "error" }) => void
}) {
  const promptAbort = createPromptAbort(input)
  return createGoalAwareAbort({
    hasActiveGoal: input.hasActiveGoal,
    stopGoal: input.stopGoal,
    promptAbort,
    onStopGoalError: (err) => {
      input.showToast({
        title: input.stopGoalFailedTitle(),
        description: input.errorMessage(err),
        variant: "error",
      })
    },
  })
}
