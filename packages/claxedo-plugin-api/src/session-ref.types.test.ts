import type { SessionRef } from "@claxedo/agent-runtime-contract"
import type { PluginContext, SessionsApi } from "./index"

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false
type Assert<Value extends true> = Value

export type CreatedIdentity = Assert<Equal<Awaited<ReturnType<SessionsApi["create"]>>, SessionRef>>
export type OpenIdentity = Assert<Equal<Parameters<SessionsApi["open"]>[0], SessionRef>>
export type ContextIdentity = Assert<Equal<ReturnType<PluginContext["currentSession"]>, SessionRef | undefined>>
