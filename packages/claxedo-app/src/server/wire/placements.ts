import { machineId, placementId, projectId, type MachineId } from "../ids"
import type { RuntimeRoute } from "../transport"
import type { Placement } from "../types"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"

export type PlacementRecord = {
  readonly placement: Placement
  readonly route: RuntimeRoute
}

export type BootstrapDeclaration = {
  readonly hostAggregate: boolean
  readonly issuesSessions: boolean
  readonly documents: boolean
  readonly connections: boolean
  readonly enrollmentId?: string
}

export type BootstrapCatalog = {
  readonly declaration: BootstrapDeclaration
  readonly placements: readonly PlacementRecord[]
}

export const UNENROLLED_MACHINE = "this-machine"

export const WORKTREE_ROUTE = "/experimental/worktree"

function placementKind(row: Record<string, unknown>, root: boolean): Placement["kind"] {
  if (row.kind === "cloud" || row.backing === "cloud-vm") return "cloud"
  return root ? "folder" : "worktree"
}

function remoteOf(row: Record<string, unknown>, self: string | undefined): { remote: boolean; machine?: MachineId } {
  if (row.kind === "cloud" || row.backing === "cloud-vm") return { remote: true }
  const placement = isRecord(row.placement) ? row.placement : undefined
  const enrollment = nonEmptyString(placement?.host_enrollment_id)
  const own = enrollment !== undefined && enrollment === self
  if (row.backing === "local-worktree" && !own) return { remote: true, ...(enrollment ? { machine: machineId(enrollment) } : {}) }
  return { remote: false, machine: machineId(self ?? UNENROLLED_MACHINE) }
}

function placementLabel(row: Record<string, unknown>, directory: string) {
  return nonEmptyString(row.workspace_name) ?? nonEmptyString(row.workspaceName) ?? directory.split("/").filter(Boolean).pop() ?? directory
}

function gitRemoteOf(project: Record<string, unknown>, row: Record<string, unknown>): string | undefined {
  const git = isRecord(project.git) ? project.git : {}
  return nonEmptyString(row.repo_url) ?? nonEmptyString(row.repoUrl) ?? nonEmptyString(row.git_remote) ?? nonEmptyString(row.gitRemote) ?? nonEmptyString(git.remote)
}

function placementRecord(project: Record<string, unknown>, key: string, row: Record<string, unknown>, self: string | undefined): PlacementRecord | undefined {
  const id = nonEmptyString(row.workspaceId) ?? nonEmptyString(row.workspace_id) ?? nonEmptyString(row.id) ?? key
  const owner = nonEmptyString(project.id)
  if (!owner) return undefined
  const directory = nonEmptyString(row.directory) ?? key
  const location = nonEmptyString(row.remote_directory) ?? nonEmptyString(row.remoteDirectory) ?? directory
  const { remote, machine } = remoteOf(row, self)
  const root = directory === nonEmptyString(project.worktree)
  const gitRemote = gitRemoteOf(project, row)
  return {
    placement: {
      id: placementId(id),
      projectId: projectId(owner),
      kind: placementKind(row, root),
      label: placementLabel(row, location),
      path: location,
      reachable: row.reachable === true,
      ...(machine ? { machineId: machine } : {}),
      ...(gitRemote ? { gitRemote } : {}),
    },
    route: { directory: remote ? `workspace:${id}` : directory, workspaceId: id, remote },
  }
}

export function placementsFromProjects(projects: unknown, self: string | undefined): PlacementRecord[] {
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
  const enrollmentId = nonEmptyString(host.enrollment)
  return {
    declaration: {
      hostAggregate: events.hostAggregate === true,
      issuesSessions: deployment.issuesSessions === true,
      documents: deployment.documents === true,
      connections: deployment.connections === true,
      ...(enrollmentId ? { enrollmentId } : {}),
    },
    placements: placementsFromProjects(root.project, enrollmentId),
  }
}
