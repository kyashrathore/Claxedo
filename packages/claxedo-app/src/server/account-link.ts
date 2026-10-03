import type { ProjectId } from "./ids"
import type { Project } from "./types"
import type { AccountCatalog } from "./wire/account-catalog"
import type { PlacementRecord } from "./wire/placements"

export type LinkedCatalog = {
  readonly accountWorkspaceIds: readonly string[]
  readonly placements: readonly PlacementRecord[]
  readonly projects: readonly Project[]
  readonly accountProjectIds: (projectId: ProjectId) => readonly ProjectId[]
}

function localProjectsByWorkspace(local: readonly PlacementRecord[]) {
  const owners = new Map<string, ProjectId>()
  for (const record of local) {
    if (record.route.workspaceId) owners.set(record.route.workspaceId, record.placement.projectId)
  }
  return owners
}

function pairings(local: readonly PlacementRecord[], account: AccountCatalog) {
  const owners = localProjectsByWorkspace(local)
  const localProjects = new Set(local.map((record) => record.placement.projectId))
  const pairs = new Map<ProjectId, ProjectId>()
  for (const project of account.projects) {
    if (localProjects.has(project.id)) pairs.set(project.id, project.id)
  }
  for (const record of account.placements) {
    const owner = record.route.workspaceId ? owners.get(record.route.workspaceId) : undefined
    if (owner && !pairs.has(record.placement.projectId)) pairs.set(record.placement.projectId, owner)
  }
  return { owners, pairs }
}

function accountIdsOf(account: AccountCatalog, pairs: ReadonlyMap<ProjectId, ProjectId>) {
  const ids = new Map<ProjectId, ProjectId[]>()
  for (const project of account.projects) {
    const home = pairs.get(project.id) ?? project.id
    ids.set(home, [...(ids.get(home) ?? []), project.id])
  }
  return ids
}

export function linkAccountCatalog(local: readonly PlacementRecord[], account: AccountCatalog): LinkedCatalog {
  const { owners, pairs } = pairings(local, account)
  const placements = account.placements
    .filter((record) => !record.route.workspaceId || !owners.has(record.route.workspaceId))
    .map((record) => {
      const home = pairs.get(record.placement.projectId)
      return home ? { ...record, placement: { ...record.placement, projectId: home } } : record
    })
  const ids = accountIdsOf(account, pairs)
  return {
    accountWorkspaceIds: account.placements.flatMap((record) => record.route.workspaceId ? [record.route.workspaceId] : []),
    placements,
    projects: account.projects.filter((project) => !pairs.has(project.id)),
    accountProjectIds: (projectId) => ids.get(projectId) ?? [],
  }
}
