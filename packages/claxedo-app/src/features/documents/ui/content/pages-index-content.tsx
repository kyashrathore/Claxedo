import { useQuery } from "@tanstack/solid-query"
import type { ContentMeta } from "../../../../app/workbench/state/index"
import { useClaxedoState, useShellQueryOptions as useQueryOptions } from "@/features/documents/app-ports"
import type { PaneCtx } from "../../../../app/workbench/workbench/index"
import { PageIndex } from "../../editor/document-index"

export function PagesIndexContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const queryOptions = useQueryOptions()
  const projectsQuery = useQuery(() => queryOptions.projects())
  return (
    // Documents is a global sidebar entry, above the project list, so it lists
    // every project's documents grouped by project rather than scoping to
    // `meta.directory` — the workspace that happens to host the tab. The
    // directory still decides where "New document" lands.
    <PageIndex
      scope="all"
      directory={props.meta.directory}
      projects={projectsQuery.data ?? []}
      onOpenPage={(document, projectId) => {
        // The document's OWN project decides which workspace hosts the tab; the
        // focused one is only a fallback for a project we cannot place.
        const worktree = projectsQuery.data?.find((project) => project.id === projectId)?.worktree
        state.layout.openPage(
          document.id,
          document.display_name,
          worktree ?? props.meta.directory,
          document.repository_relative_path ?? undefined,
        )
      }}
    />
  )
}
