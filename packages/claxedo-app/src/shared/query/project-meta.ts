import { queryKeys } from "./keys"
import { queryClient } from "./query-client"
import type { ProjectMeta } from "./types"

export function setProjectIcon(directory: string, value: string | undefined) {
  queryClient.setQueryData(queryKeys.directory.icon(directory), value)
}

export function upsertProjectMeta(directory: string, patch: ProjectMeta) {
  queryClient.setQueryData<ProjectMeta>(
    queryKeys.directory.projectMeta(directory),
    (previous = {}) => {
      const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
      const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
      return {
        ...previous,
        ...patch,
        icon,
        commands,
      }
    },
  )
}
