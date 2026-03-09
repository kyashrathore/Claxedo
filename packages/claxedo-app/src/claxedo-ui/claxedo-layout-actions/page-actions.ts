import type { ActionProps } from "./shared"
import { base64Encode } from "@opencode-ai/util/encode"
import { capture as phCapture } from "../../opencode-patches/observability/posthog"

export function createPageActions(props: ActionProps) {
  const handleNewPage = (groupId?: string) => {
    phCapture("page_created")
    const targetGroupId = groupId ?? props.claxedo.split.focusedId()
    if (targetGroupId) props.claxedo.dispatch({ type: "SplitFocusRequested", groupId: targetGroupId })

    const tabs = targetGroupId ? props.claxedo.groupTabs(targetGroupId) : props.claxedo.topTabs

    const current = typeof props.activeWorkspaceId === "function" ? props.activeWorkspaceId() : undefined
    const first = typeof props.projects === "function" ? props.projects()[0]?.worktree : undefined
    const dir = current || first
    const tabId = tabs.addPage("__index__", "Pages", dir)
    if (dir && tabId && typeof props.navigate === "function") props.navigate(`/${base64Encode(dir)}/tab/${tabId}`)
  }

  return {
    handleNewPage,
  }
}
