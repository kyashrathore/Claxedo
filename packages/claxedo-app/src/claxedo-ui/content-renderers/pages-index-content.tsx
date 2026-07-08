import { useQuery } from "@tanstack/solid-query"
import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { useShellQueryOptions as useQueryOptions } from "@claxedo/shell/data/query-options"
import { PageIndex } from "../components/page-index"

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
