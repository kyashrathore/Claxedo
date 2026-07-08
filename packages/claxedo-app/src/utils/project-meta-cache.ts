import type { QueryClient } from "@tanstack/solid-query"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
    url?: string
  }
  commands?: {
    start?: string
  }
}

export function setProjectIcon(queryClient: QueryClient, directory: string, value: string | undefined) {
  queryClient.setQueryData(["directory", "local", "icon", directory] as const, value)
}

export function projectIcon(queryClient: QueryClient, directory: string) {
  return queryClient.getQueryData<string | undefined>(["directory", "local", "icon", directory] as const)
}

export function projectMeta(queryClient: QueryClient, directory: string) {
  return queryClient.getQueryData<ProjectMeta>(["directory", "local", "projectMeta", directory] as const)
}

export function upsertProjectMeta(queryClient: QueryClient, directory: string, patch: ProjectMeta) {
  queryClient.setQueryData<ProjectMeta>(["directory", "local", "projectMeta", directory] as const, (previous = {}) => {
    const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
    return {
      ...previous,
      ...patch,
      icon,
      commands,
    }
  })
}
