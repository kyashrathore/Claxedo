import type { PlacementId, ProjectId } from "@/server"

export const addProjectPath = "/projects/new"

export const projectPathPattern = "/p/:projectId"

export function projectPath(id: ProjectId): string {
  return `/p/${encodeURIComponent(id)}`
}

export function placementDraftPath(id: PlacementId, harnessId?: string): string {
  const base = `/w/${encodeURIComponent(id)}/s/new`
  return harnessId ? `${base}?harness=${encodeURIComponent(harnessId)}` : base
}

export const settingsAccountsPath = "/settings/accounts"

export const settingsConnectionsPath = "/settings/connections"
