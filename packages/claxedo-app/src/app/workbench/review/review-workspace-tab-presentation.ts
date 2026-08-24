import type { ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import type { ReviewWorkspaceTab } from "@/features/review/ui/review-workspace-tabs"

/**
 * Presentation lookups for the workspace tab strip: a tab's label, its glyph,
 * the glyph's optical size, and the close button's accessible label. Pure
 * per-tab presentation — the workspace passes in the live lookups (i18n,
 * file-path resolution, process names) and keeps all activation policy.
 */
export function createReviewWorkspaceTabPresentation(deps: {
  reviewLabel: () => string
  contextLabel: () => string
  filePathFromTab: (tabId: string) => string | undefined
  processName: (processId: string) => string | undefined
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
      case "process":
        return deps.processName(tab.processId) ?? "Process"
    }
  }

  const tabIcon = (tab: ReviewWorkspaceTab): ClaxedoIconName => {
    switch (tab.kind) {
      case "review":
        return "review"
      case "context":
        return "circle-half"
      case "file":
        return "file-text"
      case "browser":
        return "globe"
      case "process":
        return "console"
    }
  }

  // Optical sizing: every icon shares the same 16px slot, but a filled square
  // (review) reads larger than an inscribed circle (context/browser) at the
  // same box, so boxy glyphs render a hair smaller and round glyphs a hair
  // larger to equalise perceived size next to the 13px label.
  const tabIconPx = (tab: ReviewWorkspaceTab): number => {
    switch (tab.kind) {
      case "review":
        return 13
      case "file":
      case "process":
        return 14
      case "context":
      case "browser":
        return 15
    }
  }

  const closeLabel = (tab: ReviewWorkspaceTab): string => {
    switch (tab.kind) {
      case "context":
        return "Close context"
      case "file":
        return `Close ${tabLabel(tab)} tab`
      case "browser":
        return "Close browser"
      case "process":
        return "Close process section"
      case "review":
        return "Close review"
    }
  }

  return { tabLabel, tabIcon, tabIconPx, closeLabel }
}
