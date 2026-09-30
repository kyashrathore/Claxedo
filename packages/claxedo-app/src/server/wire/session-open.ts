import { isRecord } from "@claxedo/helpers/guards"
import { errorFromBody, ServerError } from "../errors"
import type { AgentRequest, SessionGoalState, SessionStatus, Subagent, Todo } from "../types"
import { goalStateFromWire } from "./goal"
import { isPermissionWire, isQuestionWire, requestFromPermission, requestFromQuestion } from "./requests"
import { backgroundWorkFromWire, sessionStatusFromWire } from "./status"
import { subagentsFromWire } from "./subagents"

export const OPEN_VIEW = { view: "open" } as const

export const TODOS_UNSUPPORTED = "unsupported_operation"

export type SessionFact<T> = { readonly value: T } | { readonly error: ServerError }

export type SessionOpenView = {
  readonly status: SessionFact<SessionStatus | undefined>
  readonly backgroundWork: SessionFact<boolean>
  readonly requests: SessionFact<readonly AgentRequest[]>
  readonly todos: SessionFact<readonly Todo[]>
  readonly goal: SessionFact<SessionGoalState>
  readonly subagents: SessionFact<readonly Subagent[]>
}

function factFromWire<T>(value: unknown, label: string, read: (value: unknown) => T): SessionFact<T> {
  if (isRecord(value) && "value" in value) return { value: read(value.value) }
  const refusal = isRecord(value) && isRecord(value.error) ? value.error : undefined
  if (!refusal || typeof refusal.status !== "number") throw new ServerError({ class: "internal", message: `The session's ${label} answered in no known shape` })
  return {
    error: errorFromBody(refusal.status, {
      ...(typeof refusal.code === "string" ? { code: refusal.code } : {}),
      ...(typeof refusal.message === "string" ? { message: refusal.message } : {}),
    }, `The session's ${label}`),
  }
}

const listFromWire = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

function requestsFromWire(permissions: SessionFact<readonly unknown[]>, questions: SessionFact<readonly unknown[]>): SessionFact<readonly AgentRequest[]> {
  if ("error" in permissions) return permissions
  if ("error" in questions) return questions
  return {
    value: [
      ...permissions.value.filter(isPermissionWire).map(requestFromPermission),
      ...questions.value.filter(isQuestionWire).map(requestFromQuestion),
    ],
  }
}

export function sessionOpenFromWire(body: unknown): SessionOpenView {
  if (!isRecord(body)) throw new ServerError({ class: "internal", message: "The session's open view is not a record" })
  return {
    status: factFromWire(body.status, "status", sessionStatusFromWire),
    backgroundWork: factFromWire(body.status, "status", backgroundWorkFromWire),
    requests: requestsFromWire(factFromWire(body.permissions, "permissions", listFromWire), factFromWire(body.questions, "questions", listFromWire)),
    todos: factFromWire(body.todos, "todos", (value) => listFromWire(value) as readonly Todo[]),
    goal: factFromWire(body.goal, "goal", goalStateFromWire),
    subagents: factFromWire(body.subagents, "subagents", subagentsFromWire),
  }
}
