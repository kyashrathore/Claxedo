import type { SourceViewTarget } from "@claxedo/workgraph/contracts"
import { useQuery } from "@tanstack/solid-query"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { useGlobalSDK } from "@/app/providers/global-sdk/provider"
import { useShellQueryOptions } from "@/app/integrations/sync/query-options"
import type { WorkGraphClient } from "@/features/workgraph/api"
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
  // Lazy boundary: features/workgraph/api statically imports the zod-based
  // @claxedo/workgraph/contracts schemas, and this hook module is wired into the
  // settings app ports at boot (secondary-feature-ports). The client is only
  // exercised when the Settings → Connections surface calls these async methods,
  // so the api module loads on first use instead of riding the boot chunk.
  // Guarded by scripts/forbidden-eager-deps.config.ts (zod + workgraph/contracts).
  const clientConfig = { baseUrl: globalSDK.url, request: platform.fetch }
  let clientLoad: Promise<WorkGraphClient> | undefined
  const client = () =>
    (clientLoad ??= import("@/features/workgraph/api").then((module) => module.createWorkGraphClient(clientConfig)))

  return {
    list: (...args: Parameters<WorkGraphClient["sourceViews"]>) => client().then((c) => c.sourceViews(...args)),
    create: (...args: Parameters<WorkGraphClient["createSourceView"]>) => client().then((c) => c.createSourceView(...args)),
    update: (...args: Parameters<WorkGraphClient["updateSourceView"]>) => client().then((c) => c.updateSourceView(...args)),
    delete: (...args: Parameters<WorkGraphClient["deleteSourceView"]>) => client().then((c) => c.deleteSourceView(...args)),
    refresh: (...args: Parameters<WorkGraphClient["refreshSourceView"]>) =>
      client().then((c) => c.refreshSourceView(...args)),
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
