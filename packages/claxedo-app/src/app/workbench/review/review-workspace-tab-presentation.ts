import type { ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import type { ReviewWorkspaceTab } from "@/features/review/ui/review-workspace-tabs"

type ReviewWorkspaceTabKind = ReviewWorkspaceTab["kind"]

/**
 * Every tab this app can open is built by `review-workspace-tabs` — no tab kind
 * ever arrives from a wire payload or from storage — so a kind outside the union
 * is a programming error, not bad input. The guard makes that unreachability
 * explicit and keeps the presentation switches total under `noImplicitReturns`.
 */
export function unhandledReviewWorkspaceTab(tab: never): never {
  throw new Error(`Unhandled review workspace tab: ${JSON.stringify(tab)}`)
}

const TAB_ICON: Record<ReviewWorkspaceTabKind, ClaxedoIconName> = {
  review: "review",
  context: "circle-half",
  file: "document-text",
  browser: "globe",
  process: "process",
}

// Optical sizing: every icon shares the same 16px slot, but a filled square
// (review) reads larger than an inscribed circle (context/browser) at the
// same box, so boxy glyphs render a hair smaller and round glyphs a hair
// larger to equalise perceived size next to the 13px label.
const TAB_ICON_PX: Record<ReviewWorkspaceTabKind, number> = {
  review: 13,
  file: 14,
  process: 14,
  context: 15,
  browser: 15,
}

const CLOSE_LABEL: Record<Exclude<ReviewWorkspaceTabKind, "file">, string> = {
  review: "Close review",
  context: "Close context",
  browser: "Close browser",
  process: "Close process section",
}

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
      default:
        return unhandledReviewWorkspaceTab(tab)
    }
  }

  const tabIcon = (tab: ReviewWorkspaceTab): ClaxedoIconName => TAB_ICON[tab.kind]

  const tabIconPx = (tab: ReviewWorkspaceTab): number => TAB_ICON_PX[tab.kind]

  const closeLabel = (tab: ReviewWorkspaceTab): string =>
    tab.kind === "file" ? `Close ${tabLabel(tab)} tab` : CLOSE_LABEL[tab.kind]

  return { tabLabel, tabIcon, tabIconPx, closeLabel }
}
