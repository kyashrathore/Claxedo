import type { Transport } from "./transport"
import type { StatusOwner } from "./status"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"

export type SessionContext = {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly status: StatusOwner
}

export function sessionEndpoint(ref: Pick<SessionRef, "sessionId">, suffix = "") {
  return `/session/${encodeURIComponent(ref.sessionId)}${suffix}`
}
