import { useQuery } from "@tanstack/solid-query"
import { createMemo, type Accessor } from "solid-js"
import { useShellQueryOptions } from "@/features/session/app-ports"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "../data/sync/queries"
import { createActivePaneProjection } from "../store/active-pane-projection"
import { parkedPaneQueryOptions } from "../store/pane-query-observer"

export function createSessionScreenCacheProjection(input: {
  active: Accessor<boolean>
  directory: Accessor<string>
}) {
  const queryOptions = useShellQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const sourceProjects = createMemo(() => projectsQuery.data ?? [])
  const projects = createActivePaneProjection({
    active: input.active,
    read: sourceProjects,
    initial: [] as ReturnType<typeof sourceProjects>,
  })
  const directoryQuery = useQuery(() => {
    if (!input.active()) return parkedPaneQueryOptions<DirectorySessionCacheValue>("session-screen-directory", "inactive")
    return directorySessionCacheQueryOptions({ directory: input.directory() })
  })
  const sourceSessions = createMemo(() => directoryQuery.data?.session ?? [])
  const sessions = createActivePaneProjection({
    active: input.active,
    read: sourceSessions,
    initial: [] as ReturnType<typeof sourceSessions>,
  })
  return { projects, sessions, directoryReady: () => directoryQuery.data !== undefined }
}
