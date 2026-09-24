import type { ClaxedoIconName } from "@/ui"
import type { ReviewWorkspaceTab } from "./workspace-tabs"

type ReviewWorkspaceTabKind = ReviewWorkspaceTab["kind"]

export function unhandledReviewWorkspaceTab(tab: never): never {
  throw new Error(`Unhandled review workspace tab: ${JSON.stringify(tab)}`)
}

const TAB_ICON: Record<ReviewWorkspaceTabKind, ClaxedoIconName> = {
  review: "review",
  context: "circle-half",
  file: "document-text",
  browser: "globe",
  subagent: "task",
  plan: "checklist",
}

const TAB_ICON_PX: Record<ReviewWorkspaceTabKind, number> = {
  review: 13,
  file: 14,
  context: 15,
  browser: 15,
  subagent: 14,
  plan: 14,
}

const CLOSE_LABEL: Record<Exclude<ReviewWorkspaceTabKind, "file" | "subagent">, string> = {
  review: "Close review",
  context: "Close context",
  browser: "Close browser",
  plan: "Close plan",
}

export function createReviewWorkspaceTabPresentation(deps: {
  reviewLabel: () => string
  contextLabel: () => string
  subagentLabel: () => string
  subagentCloseLabel: () => string
  planLabel: () => string
  filePathFromTab: (tabId: string) => string | undefined
}) {
  const tabLabel = (tab: ReviewWorkspaceTab) => {
    switch (tab.kind) {
      case "review":
        return deps.reviewLabel()
      case "context":
        return deps.contextLabel()
      case "file":
        return deps.filePathFromTab(tab.tabId)?.split("/").at(-1) ?? tab.tabId
      case "browser":
        return "Browser"
      case "subagent":
        return tab.label ?? deps.subagentLabel()
      case "plan":
        return tab.title ?? deps.planLabel()
      default:
        return unhandledReviewWorkspaceTab(tab)
    }
  }

  const tabIcon = (tab: ReviewWorkspaceTab): ClaxedoIconName => TAB_ICON[tab.kind]

  const tabIconPx = (tab: ReviewWorkspaceTab): number => TAB_ICON_PX[tab.kind]

  const closeLabel = (tab: ReviewWorkspaceTab): string => {
    if (tab.kind === "file") return `Close ${tabLabel(tab)} tab`
    if (tab.kind === "subagent") return deps.subagentCloseLabel()
    return CLOSE_LABEL[tab.kind]
  }

  return { tabLabel, tabIcon, tabIconPx, closeLabel }
}
