import { asRecord, nonEmptyString } from "@claxedo/helpers/guards"
import { contractMismatch } from "../errors"
import { placementId, projectId, type SessionId } from "../ids"
import type { SessionLocation } from "../types"

export function localSessionLocationFromWire(input: unknown, requestedSessionId: SessionId): SessionLocation {
  const row = asRecord(input)
  const workspace = nonEmptyString(row?.workspaceId)
  const project = nonEmptyString(row?.projectId)
  if (row?.sessionId !== requestedSessionId || !workspace || !project) throw contractMismatch("local session location")
  return { sessionId: requestedSessionId, placementId: placementId(workspace), projectId: projectId(project) }
}
