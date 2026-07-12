import type { Accessor } from "solid-js"
import { capture as phCapture } from "@/platform/telemetry/analytics"
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

    phCapture("prompt_aborted")
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
