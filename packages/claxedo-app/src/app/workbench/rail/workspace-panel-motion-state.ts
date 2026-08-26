import { createSignal, onCleanup, type Accessor } from "solid-js"
import { WORKSPACE_PANEL_CLOSE_GRACE_MS } from "../../../features/workspaces/ui/panel/workspace-panel-lifecycle"

export function createWorkspacePanelMotionState(input: {
  initialOpen: boolean
  workspacePanelWidth: Accessor<number>
}) {
  const [visualOpen, setVisualOpen] = createSignal(input.initialOpen)
  const [shellMounted, setShellMounted] = createSignal(input.initialOpen)
  const [bridgeChromeVisible, setBridgeChromeVisible] = createSignal(false)
  let panelShell: HTMLElement | undefined
  let floatingChrome: HTMLElement | undefined
  let workbenchColumn: HTMLElement | undefined
  let visualOpenValue = input.initialOpen
  let visualOverride: boolean | undefined
  let bridgeChromeTimer: ReturnType<typeof setTimeout> | undefined
  let shellDisposalTimer: ReturnType<typeof setTimeout> | undefined

  const ensureShellMounted = () => {
    if (shellDisposalTimer) {
      clearTimeout(shellDisposalTimer)
      shellDisposalTimer = undefined
    }
    setShellMounted(true)
  }

  const scheduleShellDisposal = () => {
    if (shellDisposalTimer) return
    shellDisposalTimer = setTimeout(() => {
      shellDisposalTimer = undefined
      if (visualOpenValue) return
      setShellMounted(false)
    }, WORKSPACE_PANEL_CLOSE_GRACE_MS)
  }

  const setVisualPhase = (open: boolean, button?: HTMLButtonElement) => {
    visualOverride = open
    visualOpenValue = open
    if (bridgeChromeTimer) clearTimeout(bridgeChromeTimer)
    if (open) ensureShellMounted()
    setBridgeChromeVisible(true)
    applyWorkspacePanelMotionDom(open, button)

    if (open) {
      setVisualOpen(true)
      bridgeChromeTimer = setTimeout(() => {
        setBridgeChromeVisible(false)
        bridgeChromeTimer = undefined
      }, WORKSPACE_PANEL_CLOSE_GRACE_MS)
      return
    }

    setVisualOpen(false)
    scheduleShellDisposal()
    bridgeChromeTimer = undefined
  }

  const reconcileCommittedOpen = (committedOpen: boolean) => {
    if (visualOverride !== undefined) {
      if (committedOpen === visualOverride) visualOverride = undefined
      else return false
    }
    visualOpenValue = committedOpen
    if (committedOpen) ensureShellMounted()
    setVisualOpen(committedOpen)
    if (!committedOpen) scheduleShellDisposal()
    return true
  }

  onCleanup(() => {
    if (bridgeChromeTimer) clearTimeout(bridgeChromeTimer)
    if (shellDisposalTimer) clearTimeout(shellDisposalTimer)
  })

  return {
    bridgeChromeVisible,
    reconcileCommittedOpen,
    registerFloatingChrome: (element: HTMLElement | undefined) => {
      floatingChrome = element
    },
    registerPanelShell: (element: HTMLElement | undefined) => {
      panelShell = element
    },
    registerWorkbenchColumn: (element: HTMLElement | undefined) => {
      workbenchColumn = element
    },
    shellMounted,
    setVisualPhase,
    visualOpen,
    visualOpenValue: () => visualOpenValue,
  }

  function applyWorkspacePanelMotionDom(open: boolean, button?: HTMLButtonElement) {
    if (panelShell) {
      panelShell.dataset.open = String(open)
      panelShell.style.transform = open ? "translate3d(0, 0, 0)" : "translate3d(100%, 0, 0)"
      panelShell.classList.toggle("pointer-events-none", !open)
      if (open) {
        panelShell.setAttribute("aria-label", "Workspace panel")
        panelShell.setAttribute("role", "complementary")
        panelShell.removeAttribute("aria-hidden")
      }
    }
    if (floatingChrome) {
      floatingChrome.style.display = ""
      floatingChrome.style.opacity = "1"
      floatingChrome.style.pointerEvents = "auto"
      for (const toggle of floatingChrome.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-panel-toggle"]')) {
        toggle.setAttribute("aria-label", open ? "Close workspace panel" : "Open workspace panel")
        toggle.setAttribute("title", open ? "Close workspace panel" : "Open workspace panel")
        toggle.setAttribute("aria-pressed", String(open))
      }
    }
    if (button) {
      button.setAttribute("aria-label", open ? "Close workspace panel" : "Open workspace panel")
      button.setAttribute("title", open ? "Close workspace panel" : "Open workspace panel")
      button.setAttribute("aria-pressed", String(open))
    }
    if (workbenchColumn) workbenchColumn.style.marginRight = open ? `${input.workspacePanelWidth()}px` : "0px"
  }
}
