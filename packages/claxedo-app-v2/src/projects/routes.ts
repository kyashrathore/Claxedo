import type { ProjectId } from "@/server"
import { settingsPath } from "@/shell"

export const addProjectPath = "/projects/new"

export const settingsAccountsPath = settingsPath("accounts")

export function projectSettingsPath(id?: ProjectId): string {
  const list = settingsPath("projects")
  return id ? `${list}?${new URLSearchParams({ project: id }).toString()}` : list
}
