import { projectId as asProjectId, type Placement, type PlacementId, type ProjectId } from "@/server"
import type { LocalProject } from "@/projects"

export type ProjectSection = {
  readonly key: string
  readonly projectId: ProjectId | undefined
  readonly placementId: PlacementId | undefined
  readonly label: string
  readonly caption: string
  readonly dimmed: boolean
}

const READY_STATUSES: ReadonlySet<string> = new Set(["ready", "running", "active"])

function folderName(worktree: string): string {
  return worktree.split(/[\\/]/).filter(Boolean).pop() ?? worktree
}

function caption(project: LocalProject): string {
  const folder = folderName(project.worktree)
  if (!project.name || project.name === folder) return project.name ?? folder
  return `${project.name} · ${folder}`
}

function primaryPlacement(placements: readonly Placement[]): Placement | undefined {
  return placements.find((placement) => placement.kind === "folder") ?? placements[0]
}

function cloudReady(project: LocalProject, placement: Placement): boolean {
  const workspace = Object.values(project.workspaces ?? {}).find((entry) => (entry.workspaceId ?? entry.id) === placement.id)
  return workspace?.status === undefined || READY_STATUSES.has(workspace.status)
}

export function projectSection(project: LocalProject, placements: readonly Placement[]): ProjectSection {
  const id = project.id ? asProjectId(project.id) : undefined
  const primary = primaryPlacement(id ? placements.filter((placement) => placement.projectId === id) : [])
  return {
    key: project.id ?? project.worktree,
    projectId: id,
    placementId: primary?.id,
    label: project.name ?? folderName(project.worktree),
    caption: caption(project),
    dimmed: !primary || (primary.kind === "cloud" && !cloudReady(project, primary)),
  }
}
