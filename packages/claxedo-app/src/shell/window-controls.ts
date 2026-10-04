import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { DesktopBridge } from "@/lib/desktop-bridge"

type FullscreenSource = Pick<DesktopBridge, "getWindowFullscreen" | "onFullscreenChange">

export function trackMacWindowControls(bridge: FullscreenSource | undefined, mac: boolean): Accessor<boolean> {
  if (!bridge || !mac) return () => false
  const [fullscreen, setFullscreen] = createSignal(false)
  let heard = false
  onCleanup(
    bridge.onFullscreenChange((next) => {
      heard = true
      setFullscreen(next)
    }),
  )
  void bridge.getWindowFullscreen().then((initial) => {
    if (!heard) setFullscreen(initial)
  })
  return () => !fullscreen()
}
