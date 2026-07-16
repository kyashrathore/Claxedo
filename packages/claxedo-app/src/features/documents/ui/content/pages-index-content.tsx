import { useQuery } from "@tanstack/solid-query"
import type { ContentMeta } from "../../../../app/workbench/state/index"
import { useClaxedoState, useShellQueryOptions as useQueryOptions } from "@/features/documents/app-ports"
import type { PaneCtx } from "../../../../app/workbench/workbench/index"
import { PageIndex } from "../../editor/page-index"

export function PagesIndexContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  return (
    <PageIndex
      scope={props.meta.directory ? "project" : "all"}
      directory={props.meta.directory}
      projects={projectsQuery.data ?? []}
      onOpenPage={(document) => {
        const directory = document.project_id ? props.meta.directory : undefined
        state.layout.openPage(
          document.id,
          document.display_name,
          directory,
          document.repository_relative_path ?? undefined,
        )
      }}
    />
  )
}
