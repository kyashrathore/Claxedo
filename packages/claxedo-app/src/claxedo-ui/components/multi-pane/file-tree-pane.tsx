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
  sendFocusFile,
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

  const session = () => {
    const layout = claxedo.multiPane.activeLayout(props.tabId)
    if (!layout) return
    return Object.values(layout.contents).find(
      (item) =>
        (item.type === "session" || item.type === "review-workspace" || item.type === "context") &&
        item.sessionId &&
        item.sessionId !== "new",
    )?.sessionId
  }

  const focus = (path: string) => {
    if (sendFocusFile(props.tabId, path) > 0) return true
    setTimeout(() => {
      sendFocusFile(props.tabId, path)
    }, 0)
    return false
  }

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
    if (!focus(node.path) && !claxedo.multiPane.hasReviewWorkspace(props.tabId)) {
      const sid = session()
      claxedo.multiPane.toggleReviewWorkspace(props.tabId, props.directory, sid, sid ? "session" : "uncommitted")
    }
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
