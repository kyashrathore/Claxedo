import { TERMINAL_FIT_EVENT } from "@/lib/terminal-fit"
import type { ResizeCoordinator } from "./resize-coordinator"

export function listenResizeTriggers(input: {
  coordinator: ResizeCoordinator
  checkSuspension: () => void
  disposed: () => boolean
}): () => void {
  const { coordinator } = input
  const handleWindowResize = () => {
    input.checkSuspension()
    coordinator.request()
  }
  const handleVisible = () => {
    if (!document.hidden) coordinator.request()
  }
  window.addEventListener("resize", handleWindowResize)
  window.addEventListener(TERMINAL_FIT_EVENT, handleWindowResize)
  window.addEventListener("focus", handleVisible)
  document.addEventListener("visibilitychange", handleVisible)
  const mountFrame = requestAnimationFrame(() => coordinator.request())
  void document.fonts.ready.then(() => {
    if (!input.disposed()) coordinator.request()
  })
  return () => {
    cancelAnimationFrame(mountFrame)
    window.removeEventListener("resize", handleWindowResize)
    window.removeEventListener(TERMINAL_FIT_EVENT, handleWindowResize)
    window.removeEventListener("focus", handleVisible)
    document.removeEventListener("visibilitychange", handleVisible)
  }
}
