import type { ActionProps } from "./shared"
import { pagesApi } from "../../utils/pages-api"
import { base64Encode } from "@opencode-ai/util/encode"

export function createPageActions(props: ActionProps) {
  const handleNewPage = async (groupId?: string) => {
    const targetGroupId = groupId ?? props.claxedo.split.focusedId()
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs

    try {
      const page = await pagesApi.create("Untitled")
      const current = typeof props.activeWorkspaceId === "function" ? props.activeWorkspaceId() : undefined
      const first = typeof props.projects === "function" ? props.projects()[0]?.worktree : undefined
      const dir = current || first
      const tabId = tabs.addPage(page.id, page.title, dir)
      if (dir && tabId && typeof props.navigate === "function") props.navigate(`/${base64Encode(dir)}/tab/${tabId}`)
    } catch (err) {
      console.error("Failed to create page:", err)
    }
  }

  return {
    handleNewPage,
  }
}
