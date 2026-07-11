import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"

import { requestTerminalFitOnPaneChange } from "../terminal/terminal-fit"

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

  onMount(() => {
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
      const unsubscribe = api.onFullscreenChange(setMacFullscreen)
      onCleanup(unsubscribe)
      return
    }

    window.addEventListener("resize", guess)
    onCleanup(() => window.removeEventListener("resize", guess))
  })

  createEffect(
    on(
      () => [props.paneCount(), props.splitRoot()] as const,
      () => {
        requestTerminalFitOnPaneChange()
      },
      { defer: true },
    ),
  )

  return {
    trafficLightPad: () => props.isMac && !macFullscreen(),
    mobileSidebarOpen,
    closeMobileSidebar: () => setMobileSidebarOpen(false),
  }
}
