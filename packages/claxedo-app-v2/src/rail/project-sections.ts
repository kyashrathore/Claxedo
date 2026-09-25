import type { Placement, PlacementId, Project, ProjectId } from "@/server"

export type ProjectSection = {
  readonly key: string
  readonly projectId: ProjectId
  readonly placementId: PlacementId | undefined
  readonly placementIds: readonly PlacementId[]
  readonly label: string
  readonly caption: string
  readonly dimmed: boolean
}

function folderName(directory: string | undefined): string | undefined {
  return directory?.split(/[\\/]/).filter(Boolean).pop()
}

function caption(project: Project): string {
  const folder = folderName(project.directory)
  if (!folder || project.name === folder) return project.name
  return `${project.name} · ${folder}`
}

function primaryPlacement(placements: readonly Placement[]): Placement | undefined {
  return placements.find((placement) => placement.kind === "folder") ?? placements[0]
}

export function projectSection(project: Project, placements: readonly Placement[]): ProjectSection {
  const owned = placements.filter((placement) => placement.projectId === project.id)
  const primary = primaryPlacement(owned)
  return {
    key: project.id,
    projectId: project.id,
    placementId: primary?.id,
    placementIds: owned.map((placement) => placement.id),
    label: project.name,
    caption: caption(project),
    dimmed: !primary || !project.available,
  }
}
