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
      onOpenPage={(page) => {
        const directory = page.project_id
          ? page.directory || props.meta.directory || page.project_worktree || undefined
          : undefined
        state.layout.openPage(page.id, page.title, directory, page.source_path ?? undefined)
      }}
    />
  )
}
