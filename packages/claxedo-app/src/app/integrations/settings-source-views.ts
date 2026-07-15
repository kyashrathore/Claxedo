import type { SourceViewTarget } from "@claxedo/workgraph/contracts"
import { useQuery } from "@tanstack/solid-query"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import { createWorkGraphClient } from "@/features/workgraph/api"
import { workGraphExecutionContext } from "./workgraph-execution-context"

export type SourceViewProject = {
  id: string
  label: string
  target: SourceViewTarget
}

export function useSettingsSourceViews() {
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const queryOptions = useShellQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  const client = createWorkGraphClient({ baseUrl: globalSDK.url, request: platform.fetch })

  return {
    list: client.sourceViews,
    create: client.createSourceView,
    update: client.updateSourceView,
    delete: client.deleteSourceView,
    refresh: client.refreshSourceView,
    projects: (): SourceViewProject[] => (projectsQuery.data ?? []).flatMap((project) => {
      const environment = workGraphExecutionContext(project.worktree, [project])
      if (!environment) return []
      const remoteUrl = environment.kind === "hosted_workspace" ? environment.repositoryUrl : undefined
      return [{
        id: project.worktree,
        label: project.worktree,
        target: {
          environment,
          repository: { ...(remoteUrl ? { remoteUrl } : {}), baseRevision: "HEAD" },
        },
      }]
    }),
  }
}
