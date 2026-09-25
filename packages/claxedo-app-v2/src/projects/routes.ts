import type { ProjectId } from "@/server"
import { settingsPath } from "@/shell"

export function projectSettingsPath(id?: ProjectId): string {
  const list = settingsPath("projects")
  return id ? `${list}?${new URLSearchParams({ project: id }).toString()}` : list
}
