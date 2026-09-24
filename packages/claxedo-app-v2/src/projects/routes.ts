import type { ProjectId } from "@/server"

export const addProjectPath = "/projects/new"

export const projectPathPattern = "/p/:projectId"

export function projectPath(id: ProjectId): string {
  return `/p/${encodeURIComponent(id)}`
}

export const settingsAccountsPath = "/settings/accounts"

export const settingsConnectionsPath = "/settings/connections"
