import type { PrivateSessionRegistrationState, ReservePrivateSessionInput } from "@claxedo/server-core/platform/auth/private-session-authority"
import { D1SessionAuthorityError, optionalText, requireText } from "./session-input"

export type RegistrationRow = {
  operation_id: string
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  creator_actor_id: string
  operation_kind: "create" | "fork"
  parent_session_id: string | null
  requested_title: string | null
  state: PrivateSessionRegistrationState
  state_reason: string | null
  created_at: number
  updated_at: number
}

export function normalizeReservation(input: ReservePrivateSessionInput) {
  const kind = input.kind
  if (kind !== "create" && kind !== "fork")
    throw new D1SessionAuthorityError("invalid_input", "Unknown reservation kind")
  const parentSessionId = optionalText(input.parentSessionId, "parentSessionId")
  if ((kind === "fork") !== !!parentSessionId) {
    throw new D1SessionAuthorityError("invalid_input", "Fork reservations require exactly one parent session")
  }
  return {
    operationId: requireText(input.operationId, "operationId"),
    sessionId: requireText(input.sessionId, "sessionId"),
    workspaceId: requireText(input.workspaceId, "workspaceId"),
    kind,
    parentSessionId,
    title: optionalText(input.title, "title", 2_000),
  }
}

export function requireSameRegistration(
  row: RegistrationRow,
  intent: ReturnType<typeof normalizeReservation>,
  workspace: { workspace_id: string; org_id: string; project_id: string },
  actorId: string,
) {
  if (
    row.session_id !== intent.sessionId ||
    row.workspace_id !== workspace.workspace_id ||
    row.org_id !== workspace.org_id ||
    row.project_id !== workspace.project_id ||
    row.creator_actor_id !== actorId ||
    row.operation_kind !== intent.kind ||
    row.parent_session_id !== (intent.parentSessionId ?? null) ||
    row.requested_title !== (intent.title ?? null)
  )
    throw new D1SessionAuthorityError("resource_conflict", "Reservation retry changed immutable intent")
}

export function registrationResult(row: RegistrationRow, changed: boolean) {
  return {
    changed,
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    state: row.state,
  }
}
