import { isRecord } from "@claxedo/helpers/guards"
import { ServerError, statusError } from "../errors"

export const SESSION_ACTIVITY_PATH = "/api/wr/session-activity"

export type WorkspaceActivity = {
  readonly status: unknown
  readonly permissions: readonly unknown[]
  readonly questions: readonly unknown[]
}

export type SessionActivity = {
  readonly read: ReadonlyMap<string, WorkspaceActivity>
  readonly failed: ReadonlyMap<string, ServerError>
}

function unreadable(): ServerError {
  return new ServerError({ class: "internal", message: "The session activity read answered in an unreadable shape" })
}

function arrayField(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw unreadable()
  return value
}

export function sessionActivityFromWire(body: unknown): SessionActivity {
  if (!isRecord(body)) throw unreadable()
  const read = new Map<string, WorkspaceActivity>()
  const failed = new Map<string, ServerError>()
  for (const row of arrayField(body.workspaces)) {
    if (!isRecord(row) || typeof row.workspaceId !== "string") throw unreadable()
    read.set(row.workspaceId, { status: row.status, permissions: arrayField(row.permissions), questions: arrayField(row.questions) })
  }
  for (const row of arrayField(body.failures)) {
    if (!isRecord(row) || typeof row.workspaceId !== "string" || typeof row.status !== "number" || typeof row.error !== "string") throw unreadable()
    failed.set(row.workspaceId, statusError(row.status, row.error, "The workspace's session activity read"))
  }
  return { read, failed }
}
