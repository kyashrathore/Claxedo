import type { QuestionAnswer } from "@opencode-ai/sdk/v2"
import { queryClient } from "@/shared/query/query-client"

export const sessionQuestionDockQueryRoot = ["shell", "session-question-dock"] as const

export type SessionQuestionDockSnapshot = {
  tab: number
  answers: QuestionAnswer[]
  custom: string[]
  customOn: boolean[]
}

export function sessionQuestionDockQueryKey(requestID: string) {
  return [...sessionQuestionDockQueryRoot, requestID] as const
}

export function sessionQuestionDockSnapshot(requestID: string) {
  return clone(queryClient.getQueryData<SessionQuestionDockSnapshot>(sessionQuestionDockQueryKey(requestID)))
}

export function setSessionQuestionDockSnapshot(requestID: string, snapshot: SessionQuestionDockSnapshot) {
  queryClient.setQueryData(sessionQuestionDockQueryKey(requestID), clone(snapshot))
}

export function clearSessionQuestionDockSnapshot(requestID: string) {
  queryClient.removeQueries({ queryKey: sessionQuestionDockQueryKey(requestID), exact: true })
}

export function resetSessionQuestionDockSnapshotsForTest() {
  queryClient.removeQueries({ queryKey: sessionQuestionDockQueryRoot })
}

function clone(snapshot: SessionQuestionDockSnapshot | undefined) {
  if (!snapshot) return undefined
  return {
    tab: snapshot.tab,
    answers: snapshot.answers.map((answer) => [...answer]),
    custom: snapshot.custom.map((value) => value ?? ""),
    customOn: snapshot.customOn.map((value) => value === true),
  }
}
