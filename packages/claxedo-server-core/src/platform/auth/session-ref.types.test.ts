import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { HostSessionRow, HostSessionRowRefusal, HostSessionRowsPublication } from "./host-session-rows"

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

export type PublishedIdentity = Assert<Equal<Pick<HostSessionRow, keyof SessionRef>, SessionRef>>
export type RemovedIdentity = Assert<Equal<HostSessionRowsPublication["removed"][number], SessionRef>>
export type RefusedIdentity = Assert<Equal<Pick<HostSessionRowRefusal, keyof SessionRef>, SessionRef>>
