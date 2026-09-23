import type { GlobalSessionItem } from "./types"
import { sessionRowDirectory } from "@/platform/identity/workspace-address"
import { normalizeSessionTurnOutcome, type ClaxedoSession } from "../session-types"
import { cmp } from "@/platform/query/sort"
import { workspaceHostingKind } from "@/platform/runtime/agent/signed-workspace"
import { asFiniteNumber, asRecord, asString } from "@claxedo/helpers/guards"
import { placementProvisioner } from "@/platform/runtime/placement-wire"

function workspaceDirectory(row: Record<string, unknown>) {
  const workspaceId = asString(row.workspace_id) ?? asString(row.workspaceId)
  return sessionRowDirectory({ workspaceId, hostDirectory: asString(row.remote_directory) ?? asString(row.remoteDirectory) ?? asString(row.directory) ?? "/workspace" })
}

export function signedInventoryItems(input: { workspaces: unknown[]; sessionsByWorkspace: Record<string, unknown[]> }) {
  return input.workspaces.flatMap((workspace) => {
    const row = asRecord(workspace)
    if (!row) return []
    const workspaceId = asString(row?.workspace_id) ?? asString(row?.workspaceId)
    if (!workspaceId) return []
    const directory = workspaceDirectory(row)
    const projectID = asString(row?.project_id) ?? asString(row?.projectID) ?? workspaceId
    return (input.sessionsByWorkspace[workspaceId] ?? []).flatMap((session) => {
      const item = asRecord(session)
      const id = asString(item?.session_id) ?? asString(item?.sessionID) ?? asString(item?.id)
      if (!id) return []
      const created = asFiniteNumber(item?.created_at) ?? asFiniteNumber(item?.createdAt) ?? 0
      const updated = asFiniteNumber(item?.updated_at) ?? asFiniteNumber(item?.updatedAt) ?? created
      const lastTurn = normalizeSessionTurnOutcome(item?.lastTurn)
      return [{
        id,
        title: asString(item?.title) ?? id,
        directory,
        workspaceId,
        workspaceName: asString(row?.workspace_name) ??
          asString(row?.workspaceName) ??
          asString(row?.display_name) ??
          asString(row?.displayName),
        projectID,
        tags: [],
        attachments: [],
        environment: {
          kind: workspaceHostingKind(row),
          driver: placementProvisioner(row),
        },
        ...(lastTurn ? { lastTurn } : {}),
        time: { created, updated },
      } satisfies GlobalSessionItem]
    })
  })
}

/**
 * Inventory rows as session-list rows.
 *
 * An inventory row carries no `slug` or `version`; `ClaxedoSession` makes both
 * optional for exactly this reason, so the row is built to the type rather than
 * asserted into it. Synthesizing empty strings here would enter the session
 * cache and could overwrite a real slug/version on the next canonical merge.
 */
export function mapInventoryToSessions(items: GlobalSessionItem[]): ClaxedoSession[] {
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
    }) satisfies ClaxedoSession)
    .sort((a, b) => cmp(a.id, b.id))
}
