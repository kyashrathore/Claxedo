import type { ContentMeta } from "../state"
import { useClaxedoState } from "../state"
import type { PaneCtx } from "../layout"
import { DirectoryScope } from "../components/directory-scope"
import { TabWorkgraph } from "../components/tab-workgraph"

export function WorkgraphContent(props: { meta: ContentMeta; ctx: PaneCtx }) {
  const state = useClaxedoState()
  if (!props.meta.directory) return <TabWorkgraph onBackToIndex={() => state.layout.openPagesIndex()} />
  return (
    <DirectoryScope directory={props.meta.directory}>
      <TabWorkgraph onBackToIndex={() => state.layout.openPagesIndex(props.meta.directory)} />
    </DirectoryScope>
  )
}
