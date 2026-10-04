import { isRecord } from "@claxedo/helpers/guards"
import { machineId, placementId, projectId } from "../ids"
import type { Placement, Project, ProjectSource } from "../types"
import type { PlacementRecord } from "./placements"

export type AccountCatalog = {
  readonly projects: readonly Project[]
  readonly placements: readonly PlacementRecord[]
}

type Row = Record<string, unknown>

function firstTextOf(row: Row, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function firstTimeOf(row: Row, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function ownerRepository(remote: string | undefined) {
  return remote?.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

function projectName(row: Row, id: string) {
  return firstTextOf(row, "project_name", "projectName", "repo_name", "repoName") ?? ownerRepository(firstTextOf(row, "repo_url", "repoUrl")) ?? firstTextOf(row, "display_name", "displayName", "workspace_name", "workspaceName") ?? id
}

function placementRecordFromRow(row: Row, workspace: string, project: string): PlacementRecord {
  const cloud = firstTextOf(row, "backing") !== "local-worktree"
  const host = isRecord(row.placement) ? firstTextOf(row.placement, "host_enrollment_id") : undefined
  const remoteDirectory = firstTextOf(row, "remote_directory", "remoteDirectory")
  const gitRemote = firstTextOf(row, "repo_url", "repoUrl")
  const branch = firstTextOf(row, "git_branch", "gitBranch")
  const placement: Placement = {
    id: placementId(workspace),
    projectId: projectId(project),
    kind: cloud ? "cloud" : "worktree",
    label: firstTextOf(row, "workspace_name", "workspaceName", "display_name", "displayName") ?? workspace,
    ...(remoteDirectory ? { path: remoteDirectory } : {}),
    ...(branch ? { branch } : {}),
    reachable: row.reachable === true,
    onThisMachine: false,
    ...(host ? { machineId: machineId(host) } : {}),
    ...(gitRemote ? { gitRemote } : {}),
  }
  return { placement, route: { directory: `workspace:${workspace}`, workspaceId: workspace, remote: true } }
}

function projectSource(rows: readonly Row[], placements: readonly PlacementRecord[]): ProjectSource | undefined {
  for (const row of rows) {
    const connectionId = firstTextOf(row, "repo_connection_id", "repoConnectionId")
    const fullName = ownerRepository(firstTextOf(row, "repo_url", "repoUrl"))
    if (connectionId && fullName) return { kind: "connectedRepository", connectionId, fullName }
  }
  const repository = placements.map((record) => record.placement.gitRemote).find((remote) => remote !== undefined)
  return repository ? { kind: "repository", url: repository } : undefined
}

function projectFromRows(id: string, rows: readonly Row[], placements: readonly PlacementRecord[]): Project {
  const named = rows.map((row) => projectName(row, id)).find((name) => name !== id) ?? id
  const source = projectSource(rows, placements)
  const created = Math.min(...rows.map((row) => firstTimeOf(row, "created_at", "createdAt") ?? 0))
  const updated = Math.max(...rows.map((row) => firstTimeOf(row, "updated_at", "updatedAt", "last_seen_at") ?? created))
  return {
    id: projectId(id),
    name: named,
    ...(source ? { source } : {}),
    available: placements.some((record) => record.placement.reachable),
    env: {},
    createdAt: created,
    updatedAt: updated,
  }
}

export function accountCatalogFromWire(rows: readonly unknown[]): AccountCatalog {
  const groups = new Map<string, { rows: Row[]; placements: PlacementRecord[] }>()
  const seen = new Set<string>()
  for (const row of rows.filter(isRecord)) {
    const workspace = firstTextOf(row, "workspace_id", "workspaceId", "id")
    if (!workspace || seen.has(workspace)) continue
    seen.add(workspace)
    const project = firstTextOf(row, "project_id", "projectId") ?? workspace
    const group = groups.get(project) ?? { rows: [], placements: [] }
    group.rows.push(row)
    group.placements.push(placementRecordFromRow(row, workspace, project))
    groups.set(project, group)
  }
  return {
    projects: [...groups.entries()].map(([id, group]) => projectFromRows(id, group.rows, group.placements)),
    placements: [...groups.values()].flatMap((group) => group.placements),
  }
}
