import type { SessionRef } from "../../shell/identity/session-ref"

export type SessionIdentity = {
  id?: string
  scope: "pane"
  directory?: string
  surfaceId?: string
}

export function resolveSessionIdentity(input: {
  previous?: SessionIdentity
  pane?: {
    id?: string
    directory: string
    surfaceId?: string
  }
}): SessionIdentity {
  const next = {
    id: input.pane?.id,
    scope: "pane" as const,
    directory: input.pane?.directory,
    surfaceId: input.pane?.surfaceId,
  }
  if (input.pane?.id && input.pane.id !== "new") return next
  if (
    input.pane &&
    !input.pane.id &&
    input.previous &&
    input.previous.id &&
    input.previous.id !== "new" &&
    input.previous.directory === input.pane.directory &&
    input.previous.surfaceId === input.pane.surfaceId
  ) {
    return input.previous
  }
  return next
}

export function resolveSessionDirectory(input: {
  routeDirectory: string
  sessionRef?: SessionRef
  inventoryDirectory?: string
}) {
  if (input.sessionRef?.toolSandbox?.kind === "local") return input.sessionRef.toolSandbox.cwd
  if (input.sessionRef?.cwd) return input.sessionRef.cwd
  if (input.inventoryDirectory) return input.inventoryDirectory
  return input.routeDirectory
}
