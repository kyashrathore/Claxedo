import type { SessionRef } from "../../shell/identity/session-ref"
import type { ContentPayload, SessionContentPayload } from "./types"

export function sessionContentPayload(input: {
  current?: ContentPayload
  directory: string
  sessionId: string
  sessionRef?: SessionRef
  title?: string
}): SessionContentPayload {
  const title = input.title ?? input.current?.title
  return {
    ...(input.current?.type === "session" ? input.current : { type: "session" as const }),
    directory: input.directory,
    sessionId: input.sessionId,
    ...(title ? { title } : {}),
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
  }
}
