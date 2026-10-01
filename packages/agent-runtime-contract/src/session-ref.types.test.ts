import type { AgentExecutionBinding, AgentSessionStartBinding, SessionRef } from "./index"

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

export type SessionRefShape = Assert<Equal<SessionRef, Readonly<{ sessionId: string; workspaceId: string }>>>
export type ExecutionIdentity = Assert<Equal<Pick<AgentExecutionBinding, keyof SessionRef>, SessionRef>>
export type StartIdentity = Assert<Equal<Pick<AgentSessionStartBinding, keyof SessionRef>, SessionRef>>

// @ts-expect-error
export const noWorkspace: SessionRef = { sessionId: "session-1" }
// @ts-expect-error
export const nullWorkspace: SessionRef = { sessionId: "session-1", workspaceId: null }
// @ts-expect-error
export const projectReference: SessionRef = { sessionId: "session-1", workspaceId: "workspace-1", projectId: "project-1" }

function cannotRebind(ref: SessionRef) {
  // @ts-expect-error
  ref.workspaceId = "workspace-elsewhere"
}
void cannotRebind
