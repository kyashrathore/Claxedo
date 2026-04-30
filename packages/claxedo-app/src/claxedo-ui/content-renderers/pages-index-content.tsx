import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { useGlobalSync } from "@/context/global-sync"
import { PageIndex } from "../components/page-index"

export function PagesIndexContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  const globalSync = useGlobalSync()
  return (
    <PageIndex
      scope={props.meta.directory ? "project" : "all"}
      directory={props.meta.directory}
      projects={globalSync.data.project as Array<{ id: string; name?: string | null; worktree: string; sandboxes?: string[] }>}
      onOpenPage={(page) => {
        const directory = page.project_id
          ? page.directory || props.meta.directory || page.project_worktree || undefined
          : undefined
        state.layout.openPage(page.id, page.title, directory, page.file_path ?? undefined)
      }}
    />
  )
}
