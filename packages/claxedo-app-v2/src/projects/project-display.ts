import { getFilename } from "@opencode-ai/ui/utils/path"
import type { EngineProject, EngineProjectIcon } from "@/server"
import { AVATAR_COLOR_KEYS } from "./project-list"

export function getAvatarColors(key?: string) {
  if (key && (AVATAR_COLOR_KEYS as readonly string[]).includes(key)) {
    return {
      background: `var(--avatar-background-${key})`,
      foreground: `var(--avatar-text-${key})`,
    }
  }
  return {
    background: "var(--surface-info-base)",
    foreground: "var(--text-base)",
  }
}

export function projectAvatarSource(icon?: EngineProjectIcon) {
  if (icon?.override) return icon.override
  if (icon?.color) return undefined
  return icon?.url
}

export function projectLabel(project: Pick<EngineProject, "name" | "worktree">): string {
  return project.name?.trim() || getFilename(project.worktree)
}

export function projectDetail(project: Pick<EngineProject, "id" | "worktree" | "workspaces">): string {
  const hosted = Object.values(project.workspaces).some((workspace) => workspace.kind !== undefined && workspace.kind !== "local")
  return hosted ? project.id : project.worktree
}
