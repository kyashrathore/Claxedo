/**
 * FileTreePane
 *
 * A standalone file-tree rendered as a multi-pane leaf.
 * Clicking a file either routes it to a bound review-workspace
 * pane (via pane-bus) or opens it as a file tab in the group.
 */

import { createEffect, onCleanup } from "solid-js"
import FileTree from "@/components/file-tree"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import {
  autoBind,
  dispatch,
  getBound,
  peersWithCapability,
  unbind,
  usePane,
} from "../../context/pane-bus"

export function FileTreePane(props: {
  directory: string
  tabId: string
  leafId: string
  groupId: string
}) {
  const claxedo = useClaxedoLayout()

  usePane({
    leafId: props.leafId,
    tabId: props.tabId,
    type: "filetree",
    name: () => "Files",
    capabilities: [],
    handlers: {},
  })

  createEffect(() => {
    peersWithCapability("review:focus-file", props.tabId)
    autoBind(props.leafId, "review", "review:focus-file")
  })

  onCleanup(() => {
    unbind("review", props.leafId)
  })

  const handleFileClick = (node: { path: string }) => {
    const target = getBound("review", props.leafId)
    if (
      target &&
      dispatch(target, {
        type: "review:focus-file",
        payload: { path: node.path },
      })
    ) {
      return
    }
    const filename = node.path.split("/").at(-1) ?? node.path
    claxedo.groupTabs(props.groupId).addFile(props.directory, node.path, filename)
  }

  return (
    <div class="flex flex-col size-full overflow-hidden bg-background-stronger">
      <div class="flex-1 min-h-0 overflow-auto px-3 py-0">
        <FileTree
          path=""
          onFileClick={handleFileClick}
        />
      </div>
    </div>
  )
}
