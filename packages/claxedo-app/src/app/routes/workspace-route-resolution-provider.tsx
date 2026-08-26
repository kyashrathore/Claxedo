import { createContext, createMemo, type Accessor, type ParentProps, useContext } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer } from "@/app/connection/server"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { parseShellRoute } from "@/platform/identity/route"
import { workspaceResolveQuery } from "@/platform/runtime/workspace-runtime-record"
import {
  resolveWorkspaceRoute,
  shellRouteWorkspaceId,
  type WorkspaceRouteResolution,
} from "./workspace-route-resolution"

const WorkspaceRouteResolutionContext = createContext<Accessor<WorkspaceRouteResolution | undefined>>()

export function WorkspaceRouteResolutionProvider(
  props: ParentProps<{ resolution: Accessor<WorkspaceRouteResolution | undefined> }>,
) {
  return <WorkspaceRouteResolutionContext value={props.resolution}>{props.children}</WorkspaceRouteResolutionContext>
}

export function useResolvedWorkspaceRoute() {
  const resolution = useContext(WorkspaceRouteResolutionContext)
  if (!resolution) throw new Error("useResolvedWorkspaceRoute must be used inside WorkspaceRouteResolutionProvider")
  return resolution
}

export function useWorkspaceRouteResolution(pathname: Accessor<string>) {
  const server = useServer()
  const platform = usePlatform()
  const route = createMemo(() => parseShellRoute(pathname()))
  const workspaceId = createMemo(() => shellRouteWorkspaceId(route()))
  const workspaceQuery = useQuery(() => {
    const id = workspaceId()
    return {
      ...workspaceResolveQuery({
        baseUrl: server.url,
        request: platform.fetch,
        workspaceId: id ?? "__claxedo_route_without_workspace__",
      }),
      enabled: !!id,
    }
  })

  return createMemo(() => resolveWorkspaceRoute(route(), workspaceQuery.data))
}
