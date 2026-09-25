import { isRecord } from "../../lib/record"
import { projectId } from "../ids"
import type { Project } from "../types"
import { placementsFromProjects, type PlacementRecord } from "./placements"

export type AccountCatalog = {
  readonly projects: readonly Project[]
  readonly placements: readonly PlacementRecord[]
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function time(row: Record<string, unknown>, key: "created" | "updated"): number {
  const times = isRecord(row.time) ? row.time : {}
  const value = times[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function accountProject(row: Record<string, unknown>, placements: readonly PlacementRecord[]): Project | undefined {
  const id = text(row.id)
  if (!id) return undefined
  const own = placements.filter((record) => record.placement.projectId === id)
  const repository = own.map((record) => record.placement.gitRemote).find((remote) => remote !== undefined)
  return {
    id: projectId(id),
    name: text(row.name) ?? id,
    ...(repository ? { source: { kind: "repository", url: repository } } : {}),
    available: own.some((record) => record.placement.reachable),
    env: {},
    createdAt: time(row, "created"),
    updatedAt: time(row, "updated"),
  }
}

function remote(record: PlacementRecord): PlacementRecord {
  const workspaceId = record.route.workspaceId
  return { placement: record.placement, route: { directory: `workspace:${workspaceId}`, workspaceId, remote: true } }
}

export function accountCatalogFromWire(rows: readonly unknown[]): AccountCatalog {
  const placements = placementsFromProjects(rows, undefined).map(remote)
  const projects = rows.filter(isRecord).map((row) => accountProject(row, placements)).filter((project) => project !== undefined)
  return { projects, placements }
}
