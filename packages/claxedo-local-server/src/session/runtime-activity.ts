import type { SessionRowStatusKind } from "@claxedo/server-core/session/navigation-list"
import { record, raw } from "../platform/json"

export type RuntimeStatusPath = "/session/status" | "/permission" | "/question"

/** A GET on the workspace's mounted runtime, or nothing when no runtime is up. */
export type RuntimeStatusRead = (workspaceId: string, path: RuntimeStatusPath) => Promise<Response | undefined>

/** A session's status kind and the ids of its open permissions and questions, keyed `<kind>.asked:<id>`. */
export type RuntimeSessionActivity = { kind: SessionRowStatusKind; pending: Set<string> }

export function runtimeStatusKind(status: unknown): SessionRowStatusKind {
  const type = raw(record(status)?.type)
  return type === "busy" || type === "retry" || type === "recovering" ? type : "idle"
}

async function readRuntimeStatus(read: RuntimeStatusRead, workspaceId: string, path: RuntimeStatusPath) {
  const response = await read(workspaceId, path)
  if (!response) return undefined
  if (!response.ok) throw new Error(`${path} answered ${response.status} for workspace ${workspaceId}`)
  return (await response.json()) as unknown
}

/**
 * What a workspace's runtime holds right now, read in process: every session
 * that is not idle or has an open permission or question. A session the map
 * leaves out is idle with nothing open; no map at all means no runtime is up.
 */
export async function readRuntimeSessionActivity(
  read: RuntimeStatusRead,
  workspaceId: string,
): Promise<Map<string, RuntimeSessionActivity> | undefined> {
  const status = await readRuntimeStatus(read, workspaceId, "/session/status")
  if (status === undefined) return undefined
  const sessions = new Map<string, RuntimeSessionActivity>()
  for (const [sessionId, value] of Object.entries(record(status) ?? {})) {
    sessions.set(sessionId, { kind: runtimeStatusKind(value), pending: new Set() })
  }
  for (const path of ["/permission", "/question"] as const) {
    const rows = await readRuntimeStatus(read, workspaceId, path)
    for (const row of Array.isArray(rows) ? rows : []) {
      const sessionId = raw(record(row)?.sessionID)
      const id = raw(record(row)?.id)
      if (!sessionId || !id) continue
      const entry = sessions.get(sessionId) ?? { kind: "idle", pending: new Set<string>() }
      entry.pending.add(`${path.slice(1)}.asked:${id}`)
      sessions.set(sessionId, entry)
    }
  }
  return sessions
}
