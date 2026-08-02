import { createSignal } from "solid-js"
import { desktopApi } from "./api"

const OS_NAME = (() => {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return "unknown"
})()

const [webviewZoom, setWebviewZoom] = createSignal(1)

const MAX_ZOOM_LEVEL = 10
const MIN_ZOOM_LEVEL = 0.2

const clamp = (value: number) => Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)

const applyZoom = (next: number) => {
  setWebviewZoom(next)
  void desktopApi().setZoomFactor(next)
}

window.addEventListener("keydown", (event) => {
  if (!(OS_NAME === "macos" ? event.metaKey : event.ctrlKey)) return

  let next = webviewZoom()
  if (event.key === "-") next -= 0.2
  if (event.key === "=" || event.key === "+") next += 0.2
  if (event.key === "0") next = 1

  applyZoom(clamp(next))
})

export { webviewZoom }
