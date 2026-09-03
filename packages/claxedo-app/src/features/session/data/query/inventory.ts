import type { GlobalSessionItem } from "./types"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { normalizeSessionTurnOutcome, type ClaxedoSession } from "../session-types"
import { cmp } from "@/platform/query/sort"
import { workspaceHostingKind } from "@/platform/runtime/agent/signed-workspace"

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function workspaceDirectory(row: Record<string, unknown>) {
  const workspaceId = txt(row.workspace_id) ?? txt(row.workspaceId)
  return sessionRowDirectory({ workspaceId, hostDirectory: txt(row.remote_directory) ?? txt(row.remoteDirectory) ?? txt(row.directory) ?? "/workspace" })
}

export function signedInventoryItems(input: { workspaces: unknown[]; sessionsByWorkspace: Record<string, unknown[]> }) {
  return input.workspaces.flatMap((workspace) => {
    const row = rec(workspace)
    if (!row) return []
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) return []
    const directory = workspaceDirectory(row)
    const projectID = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    return (input.sessionsByWorkspace[workspaceId] ?? []).flatMap((session) => {
      const item = rec(session)
      const id = txt(item?.session_id) ?? txt(item?.sessionID) ?? txt(item?.id)
      if (!id) return []
      const created = num(item?.created_at) ?? num(item?.createdAt) ?? 0
      const updated = num(item?.updated_at) ?? num(item?.updatedAt) ?? created
      const lastTurn = normalizeSessionTurnOutcome(item?.lastTurn)
      return [{
        id,
        title: txt(item?.title) ?? id,
        directory,
        workspaceId,
        workspaceName: txt(row?.workspace_name) ??
          txt(row?.workspaceName) ??
          txt(row?.display_name) ??
          txt(row?.displayName),
        projectID,
        tags: [],
        attachments: [],
        environment: {
          kind: workspaceHostingKind(row),
          driver: txt(row?.backing) ?? txt(row?.access),
        },
        ...(lastTurn ? { lastTurn } : {}),
        time: { created, updated },
      } satisfies GlobalSessionItem]
    })
  })
}

export function mapInventoryToSessions(items: GlobalSessionItem[]) {
  return items
    .filter((item) => !item.archived)
    .map((item) => ({
      id: item.id,
      title: item.title,
      directory: item.directory,
      projectID: item.projectID,
      ...(item.parentID ? { parentID: item.parentID } : {}),
      ...(item.lastTurn ? { lastTurn: item.lastTurn } : {}),
      time: item.time,
    }) as ClaxedoSession)
    .sort((a, b) => cmp(a.id, b.id))
}
