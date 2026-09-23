import type { ProjectSource } from "@/features/workspaces/data/project-api"

export type { ProjectSource }

/**
 * The project the wizard is about, held until Finish creates it. Nothing is
 * written on either product before then, so an abandoned wizard leaves no
 * project on a desktop and no workspace on the hosted plane.
 */
export type WizardDraft = { source: ProjectSource }

/**
 * The name the server will derive from the source — the same rule
 * `projects-route.ts` applies — so the wizard can head its later steps with
 * it and the hosted workspace create can be sent the same `projectName`.
 * A folder's `origin` remote, which the server also reads, is not visible
 * from here, so a folder is named by its basename.
 */
export function draftProjectName(source: ProjectSource) {
  if (source.kind === "directory") return lastSegment(source.folder)
  if ("repoUrl" in source) return lastSegment(source.repoUrl).replace(/\.git$/, "")
  return lastSegment(source.repo.fullName)
}

function lastSegment(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
}
