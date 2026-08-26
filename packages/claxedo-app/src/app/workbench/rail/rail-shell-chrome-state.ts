import { createEffect } from "solid-js"
import { createSignal, onSettled, type Accessor } from "solid-js"

import { requestTerminalFitOnPaneChange } from "../../../features/terminal/workbench/terminal-fit"

type DesktopWindow = typeof window & {
  api?: {
    getWindowFullscreen?: () => Promise<boolean>
    onFullscreenChange?: (callback: (fullscreen: boolean) => void) => () => void
  }
}

export function useRailShellChromeState(props: {
  isMac: boolean
  paneCount: Accessor<number>
  splitRoot: Accessor<unknown>
}) {
  const [macFullscreen, setMacFullscreen] = createSignal(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false)

  onSettled(() => {
    if (!props.isMac) return

    const api = typeof window !== "undefined" ? (window as DesktopWindow).api : undefined
    const guess = () => {
      setMacFullscreen(window.innerHeight >= window.screen.height)
    }
    const sync = () => {
      if (!api?.getWindowFullscreen) {
        guess()
        return
      }
      guess()
      void api.getWindowFullscreen().then(setMacFullscreen).catch(guess)
    }

    sync()

    if (api?.onFullscreenChange) {
      return api.onFullscreenChange(setMacFullscreen)
    }

    window.addEventListener("resize", guess)
    return () => window.removeEventListener("resize", guess)
  })

  createEffect(
    () => [props.paneCount(), props.splitRoot()] as const,
    () => {
      requestTerminalFitOnPaneChange()
    },
    { defer: true },
  )

  return {
    trafficLightPad: () => props.isMac && !macFullscreen(),
    mobileSidebarOpen,
    // The narrow-viewport drawer previously had `closeMobileSidebar` as its only
    // setter (hard-wired to `false`), so nothing could ever open it — a dead-code
    // path pinned by mobile-smoke behavior 1. `openMobileSidebar` is that missing
    // opener; the workbench header (narrow) and the drawer's own opener button
    // call it. See WP-C3 collapse design note §3.1.
    openMobileSidebar: () => setMobileSidebarOpen(true),
    toggleMobileSidebar: () => setMobileSidebarOpen((open) => !open),
    closeMobileSidebar: () => setMobileSidebarOpen(false),
  }
}
