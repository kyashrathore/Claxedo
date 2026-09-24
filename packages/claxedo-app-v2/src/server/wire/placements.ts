import { machineId, placementId, projectId, type MachineId } from "../ids"
import type { RuntimeRoute } from "../transport"
import type { Placement } from "../types"
import { isRecord } from "../../lib/record"

export type PlacementRecord = {
  readonly placement: Placement
  readonly route: RuntimeRoute
}

export type BootstrapDeclaration = {
  readonly hostAggregate: boolean
  readonly issuesSessions: boolean
  readonly documents: boolean
  readonly enrollmentId?: string
}

export type BootstrapCatalog = {
  readonly declaration: BootstrapDeclaration
  readonly placements: readonly PlacementRecord[]
}

export const UNENROLLED_MACHINE = "this-machine"

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function kindOf(row: Record<string, unknown>, root: boolean): Placement["kind"] {
  if (row.kind === "cloud" || row.backing === "cloud-vm") return "cloud"
  return root ? "folder" : "worktree"
}

function remoteOf(row: Record<string, unknown>, self: string | undefined): { remote: boolean; machine?: MachineId } {
  if (row.kind === "cloud" || row.backing === "cloud-vm") return { remote: true }
  const placement = isRecord(row.placement) ? row.placement : undefined
  const enrollment = text(placement?.host_enrollment_id)
  const own = enrollment !== undefined && enrollment === self
  if (row.backing === "local-worktree" && !own) return { remote: true, ...(enrollment ? { machine: machineId(enrollment) } : {}) }
  return { remote: false, machine: machineId(self ?? UNENROLLED_MACHINE) }
}

function label(row: Record<string, unknown>, directory: string) {
  return text(row.workspace_name) ?? text(row.workspaceName) ?? directory.split("/").filter(Boolean).pop() ?? directory
}

function placementRecord(project: Record<string, unknown>, key: string, row: Record<string, unknown>, self: string | undefined): PlacementRecord | undefined {
  const id = text(row.workspaceId) ?? text(row.workspace_id) ?? text(row.id) ?? key
  const owner = text(project.id)
  if (!owner) return undefined
  const directory = text(row.directory) ?? key
  const location = text(row.remote_directory) ?? text(row.remoteDirectory) ?? directory
  const { remote, machine } = remoteOf(row, self)
  const root = directory === text(project.worktree)
  return {
    placement: {
      id: placementId(id),
      projectId: projectId(owner),
      kind: kindOf(row, root),
      label: label(row, location),
      path: location,
      reachable: row.reachable === true,
      ...(machine ? { machineId: machine } : {}),
    },
    route: { directory: remote ? `workspace:${id}` : directory, workspaceId: id, remote },
  }
}

function placementsFromProjects(projects: unknown, self: string | undefined): PlacementRecord[] {
  if (!Array.isArray(projects)) return []
  const records: PlacementRecord[] = []
  for (const candidate of projects) {
    if (!isRecord(candidate)) continue
    const workspaces = isRecord(candidate.workspaces) ? candidate.workspaces : {}
    for (const [key, row] of Object.entries(workspaces)) {
      if (!isRecord(row)) continue
      const record = placementRecord(candidate, key, row, self)
      if (record) records.push(record)
    }
  }
  return records
}

export function bootstrapCatalog(body: unknown): BootstrapCatalog {
  const root = isRecord(body) ? body : {}
  const events = isRecord(root.events) ? root.events : {}
  const deployment = isRecord(root.deployment) ? root.deployment : {}
  const host = isRecord(root.host) ? root.host : {}
  const enrollmentId = text(host.enrollment)
  return {
    declaration: {
      hostAggregate: events.hostAggregate === true,
      issuesSessions: deployment.issuesSessions === true,
      documents: deployment.documents === true,
      ...(enrollmentId ? { enrollmentId } : {}),
    },
    placements: placementsFromProjects(root.project, enrollmentId),
  }
}
