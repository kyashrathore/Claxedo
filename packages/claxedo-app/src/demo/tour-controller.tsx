/**
 * DemoTourController — renderless component that listens for postMessage
 * from the parent page and switches the active workspace content to match
 * the current tour step.
 */
import { onMount, onCleanup } from "solid-js"
import { useClaxedoState } from "../claxedo-ui/state"

// Content IDs from pre-seeded state in main.tsx
const TAB_PAGE = "tab-page-demo-001"
const TAB_SESSION = "tab-ses-wt-001"
const TAB_PROCESS = "tab-process-demo"
const TAB_WORKTREE = TAB_SESSION
const TAB_DASHBOARD = "tab-ses-p2-001"

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
  const claxedoState = useClaxedoState()
  const show = (id: string) => {
    if (!claxedoState.meta.get(id)) return
    claxedoState.layout.showContent(id)
  }

  onMount(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type !== "tour-step") return
      const action = e.data.action as TourAction

      switch (action) {
        case "multi-pane":
          show(TAB_SESSION)
          break
        case "pane-focus":
          show(TAB_SESSION)
          break
        case "pages":
          show(TAB_PAGE)
          break
        case "review":
          show(TAB_SESSION)
          break
        case "switch-workspace":
          show(TAB_WORKTREE)
          break
        case "switch-project":
          show(TAB_DASHBOARD)
          break
        case "shortcuts":
          show(TAB_SESSION)
          break
        case "process":
          show(TAB_PROCESS)
          break
      }
    }

    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  })

  return null
}
