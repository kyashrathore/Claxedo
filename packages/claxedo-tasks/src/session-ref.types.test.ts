import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { SessionRef as TasksSessionRef, Task, TaskSessionLink, StartRequest } from "./index"

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

export type TasksIdentity = Assert<Equal<TasksSessionRef, SessionRef>>
export type TaskProvenance = Assert<Equal<Task["createdFrom"], SessionRef | null>>
export type LinkedIdentity = Assert<Equal<TaskSessionLink["sessionRef"], SessionRef>>
export type CallerIdentity = Assert<Equal<StartRequest["startedFrom"], SessionRef | undefined>>
