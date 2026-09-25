import { isRecord } from "../../lib/record"
import { machineId, placementId, projectId } from "../ids"
import type { Placement, Project } from "../types"
import type { PlacementRecord } from "./placements"

export type AccountCatalog = {
  readonly projects: readonly Project[]
  readonly placements: readonly PlacementRecord[]
}

type Row = Record<string, unknown>

function text(row: Row, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function time(row: Row, ...keys: readonly string[]): number | undefined {
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
  return text(row, "project_name", "projectName", "repo_name", "repoName") ?? ownerRepository(text(row, "repo_url", "repoUrl")) ?? text(row, "display_name", "displayName", "workspace_name", "workspaceName") ?? id
}

function placementOf(row: Row, workspace: string, project: string): PlacementRecord {
  const cloud = text(row, "backing") !== "local-worktree"
  const host = isRecord(row.placement) ? text(row.placement, "host_enrollment_id") : undefined
  const remoteDirectory = text(row, "remote_directory", "remoteDirectory")
  const gitRemote = text(row, "repo_url", "repoUrl")
  const placement: Placement = {
    id: placementId(workspace),
    projectId: projectId(project),
    kind: cloud ? "cloud" : "worktree",
    label: text(row, "workspace_name", "workspaceName", "display_name", "displayName") ?? workspace,
    ...(remoteDirectory ? { path: remoteDirectory } : {}),
    reachable: row.reachable === true,
    ...(host ? { machineId: machineId(host) } : {}),
    ...(gitRemote ? { gitRemote } : {}),
  }
  return { placement, route: { directory: `workspace:${workspace}`, workspaceId: workspace, remote: true } }
}

function projectFromRows(id: string, rows: readonly Row[], placements: readonly PlacementRecord[]): Project {
  const named = rows.map((row) => projectName(row, id)).find((name) => name !== id) ?? id
  const repository = placements.map((record) => record.placement.gitRemote).find((remote) => remote !== undefined)
  const created = Math.min(...rows.map((row) => time(row, "created_at", "createdAt") ?? 0))
  const updated = Math.max(...rows.map((row) => time(row, "updated_at", "updatedAt", "last_seen_at") ?? created))
  return {
    id: projectId(id),
    name: named,
    ...(repository ? { source: { kind: "repository", url: repository } } : {}),
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
    const workspace = text(row, "workspace_id", "workspaceId", "id")
    if (!workspace || seen.has(workspace)) continue
    seen.add(workspace)
    const project = text(row, "project_id", "projectId") ?? workspace
    const group = groups.get(project) ?? { rows: [], placements: [] }
    group.rows.push(row)
    group.placements.push(placementOf(row, workspace, project))
    groups.set(project, group)
  }
  return {
    projects: [...groups.entries()].map(([id, group]) => projectFromRows(id, group.rows, group.placements)),
    placements: [...groups.values()].flatMap((group) => group.placements),
  }
}
