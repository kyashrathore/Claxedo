import { parseBackgroundWork, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import { asString as raw } from "@claxedo/helpers/guards"
import type { SessionRowStatusKind } from "./navigation-list"
import { jsonRecord as record } from "../platform/runtime/lib/json"

export type RuntimeStatusPath = "/session/status" | "/permission" | "/question"

/** A GET on the workspace's mounted runtime, or nothing when no runtime is up. */
export type RuntimeStatusRead = (workspaceId: string, path: RuntimeStatusPath) => Promise<Response | undefined>

/** A session's status kind, the ids of its open permissions and questions, keyed `<kind>.asked:<id>`, and the work its harness runs outside any turn, when there is any. */
export type RuntimeSessionActivity = { kind: SessionRowStatusKind; pending: Set<string>; backgroundWork?: BackgroundWork }

export function runtimeStatusKind(status: unknown): SessionRowStatusKind {
  const type = raw(record(status)?.type)
  return type === "busy" || type === "retry" || type === "interrupted" ? type : "idle"
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
    const backgroundWork = parseBackgroundWork(record(value)?.backgroundWork)
    sessions.set(sessionId, { kind: runtimeStatusKind(value), pending: new Set(), ...(backgroundWork ? { backgroundWork } : {}) })
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
