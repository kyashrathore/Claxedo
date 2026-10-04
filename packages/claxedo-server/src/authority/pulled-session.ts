import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { txt } from "@claxedo/server-core/session/meta/shape"
import type { WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import type { SessionProjectionWorkspace } from "@claxedo/server-core/workspace/store/index"
import type { RelayRole } from "@claxedo/workspace-relay"

type Refusal = new (status: number, code: string, message: string) => Error

export function relayRole(value: unknown): RelayRole | undefined {
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}

export function workspaceRoleAllowsWrite(role: unknown) {
  return role === "editor" || role === "admin" || role === "owner"
}

export function runtimePath(path: string, query?: Record<string, string | undefined>) {
  const url = new URL(path, "http://workspace-runtime.local")
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}

/**
 * The workspace a cloud session is pulled into, as the authority opened it. Its
 * org and project are projected onto the session's row, and every authority
 * stores both, so a workspace returned without them is refused.
 */
export function pulledCloudWorkspace(workspaceId: string, workspace: WorkspaceRecord | undefined, Refusal: Refusal) {
  const org_id = txt(workspace?.org_id)
  const project_id = txt(workspace?.project_id)
  if (!org_id || !project_id) {
    throw new Refusal(409, "workspace_identity_required", "Workspace authority returned no organization or project for the workspace")
  }
  return {
    id: workspaceId,
    org_id,
    project_id,
    directory: `workspace:${workspaceId}`,
    kind: "cloud",
  } satisfies SessionProjectionWorkspace
}

/**
 * The projection records a pulled session at its runtime's own times, so one
 * without both is refused. Only the update stamp travels to the authority: a
 * session's creation time is written once, from the runtime's `time.created`,
 * by its registration (`registerRuntimeSession`), and a visibility upsert could
 * only repeat it.
 */
function pulledSessionUpdatedAt(session: Record<string, unknown>, Refusal: Refusal) {
  const time = asRecord(session.time)
  const updatedAt = asFiniteNumber(time?.updated)
  if (updatedAt !== undefined && asFiniteNumber(time?.created) !== undefined) return updatedAt
  throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned a session without its creation and update times")
}

export function messagesPayload(input: unknown, Refusal: Refusal) {
  const row = asRecord(input)
  const session = asRecord(row?.session)
  if (!row || !Array.isArray(row.messages) || !session) {
    throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned an invalid message snapshot")
  }
  const maxEventOrdinal = row.maxEventOrdinal
  const fencingToken = row.fencingToken
  if (
    maxEventOrdinal !== undefined
    && (typeof maxEventOrdinal !== "number" || !Number.isInteger(maxEventOrdinal) || maxEventOrdinal < 0)
  ) {
    throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned an invalid message snapshot")
  }
  if (
    fencingToken !== undefined
    && (typeof fencingToken !== "number" || !Number.isSafeInteger(fencingToken) || fencingToken <= 0)
  ) {
    throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned an invalid message snapshot fence")
  }
  return {
    messages: row.messages,
    maxEventOrdinal,
    fencingToken,
    session,
  }
}

function sessionPayloadId(input: unknown) {
  const row = asRecord(input)
  return txt(row?.id) ?? txt(row?.sessionId) ?? txt(row?.sessionID)
}

/**
 * A pulled session is refused before anything is projected unless it is the
 * requested session and carries its runtime's times.
 */
export function pulledSession(input: unknown, sessionId: string, Refusal: Refusal) {
  const row = asRecord(input)
  if (!row || sessionPayloadId(row) !== sessionId) {
    throw new Refusal(409, "workspace_runtime_session_mismatch", "Workspace runtime session identity does not match requested session")
  }
  const title = txt(row.title) ?? txt(row.slug)
  return {
    sessionId,
    ...(title ? { title } : {}),
    updatedAt: pulledSessionUpdatedAt(row, Refusal),
  }
}
