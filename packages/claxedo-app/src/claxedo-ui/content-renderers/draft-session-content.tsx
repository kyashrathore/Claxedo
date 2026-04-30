import type { ContentMeta } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"
import { DraftSessionPane } from "../components/draft-session-pane"

export function DraftSessionContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  return (
    <DirectoryScope directory={props.meta.providerDirectory!}>
      <DraftSessionPane
        surfaceId={props.meta.id}
        leafId={props.meta.id}
        draftId={props.meta.draftId!}
        providerDirectory={props.meta.providerDirectory!}
        directory={props.meta.directory}
      />
    </DirectoryScope>
  )
}
