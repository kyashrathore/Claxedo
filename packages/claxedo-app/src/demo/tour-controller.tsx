/**
 * DemoTourController — renderless component that listens for postMessage
 * from the parent page and switches the active tab / pane focus to match
 * the current tour step.
 *
 * Must be mounted inside ClaxedoLayoutProvider.
 */
import { onMount, onCleanup } from "solid-js"
import { useClaxedoLayout } from "../claxedo-ui/context/claxedo-layout"

// Tab IDs from pre-seeded layout in main.tsx
const TAB_MULTI_PANE = "tab-multi-demo-001"
const TAB_PAGE = "tab-page-demo-001"
const TAB_TERMINAL = "tab-terminal-claude"
const TAB_WORKTREE = "tab-ses-wt-001"
const TAB_DASHBOARD = "tab-ses-p2-001"

// Leaf IDs from pre-seeded multi-pane layout
const LEAF_SESSION = "leaf-session-demo"
const LEAF_REVIEW = "leaf-review-demo"
const LEAF_FILETREE = "leaf-filetree-demo"

type TourAction =
  | "multi-pane"
  | "pane-focus"
  | "pages"
  | "review"
  | "switch-workspace"
  | "switch-project"
  | "shortcuts"
  | "process"

export function DemoTourController() {
  const claxedo = useClaxedoLayout()

  onMount(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== "tour-step") return
      const action = e.data.action as TourAction

      switch (action) {
        case "multi-pane":
          claxedo.topTabs.setActive(TAB_MULTI_PANE)
          claxedo.multiPane.focus(TAB_MULTI_PANE, LEAF_SESSION)
          break
        case "pane-focus":
          claxedo.topTabs.setActive(TAB_MULTI_PANE)
          claxedo.multiPane.focus(TAB_MULTI_PANE, LEAF_REVIEW)
          break
        case "pages":
          claxedo.topTabs.setActive(TAB_PAGE)
          break
        case "review":
          claxedo.topTabs.setActive(TAB_MULTI_PANE)
          claxedo.multiPane.focus(TAB_MULTI_PANE, LEAF_FILETREE)
          break
        case "switch-workspace":
          claxedo.topTabs.setActive(TAB_WORKTREE)
          break
        case "switch-project":
          claxedo.topTabs.setActive(TAB_DASHBOARD)
          break
        case "shortcuts":
          claxedo.topTabs.setActive(TAB_MULTI_PANE)
          claxedo.multiPane.focus(TAB_MULTI_PANE, LEAF_SESSION)
          break
        case "process":
          claxedo.topTabs.setActive(TAB_TERMINAL)
          break
      }
    }

    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  })

  return null
}
