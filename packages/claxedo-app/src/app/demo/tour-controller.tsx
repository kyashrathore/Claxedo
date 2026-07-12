/**
 * DemoTourController — renderless component that listens for postMessage
 * from the parent page and switches the active workspace content to match
 * the current tour step.
 */
import { onMount, onCleanup } from "solid-js"
import { useClaxedoState } from "../workbench/state/index"
import { isTrustedTourOrigin } from "./tour-origin"

// Content IDs from pre-seeded state in main.tsx
const TAB_PAGE = "tab-page-demo-001"
const TAB_SESSION = "tab-ses-wt-001"
const TAB_WORKTREE = TAB_SESSION
const TAB_DASHBOARD = "tab-ses-p2-001"
const DEMO_PROJECT = "/home/demo/projects/my-app"

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
  const showProcesses = () => {
    show(TAB_SESSION)
    claxedoState.workspacePanel.open("processes", {
      workspaceDir: claxedoState.meta.get(TAB_SESSION)?.directory ?? DEMO_PROJECT,
      navigator: "processes",
    })
  }

  onMount(() => {
    function handleMessage(e: MessageEvent) {
      // Reject messages from untrusted frames: the tour dispatches navigation
      // from `e.data` alone, so an unchecked listener lets any embedding page
      // drive this UI.
      if (!isTrustedTourOrigin(e.origin, window.location.origin)) return
      if (!isTourStepMessage(e.data)) return
      const action = e.data.action

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
          showProcesses()
          break
      }
    }

    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  })

  return null
}

function isTourStepMessage(value: unknown): value is { type: "tour-step"; action: TourAction } {
  if (!value || typeof value !== "object") return false
  if (!("type" in value) || value.type !== "tour-step") return false
  if (!("action" in value) || typeof value.action !== "string") return false
  return [
    "multi-pane",
    "pane-focus",
    "pages",
    "review",
    "switch-workspace",
    "switch-project",
    "shortcuts",
    "process",
  ].includes(value.action)
}
