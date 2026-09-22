import { createSignal } from "solid-js"
import { desktopApi } from "./api"
import { clampZoomFactor } from "../shared/zoom-factor"

const OS_NAME = (() => {
  if (navigator.userAgent.includes("Mac")) return "macos"
  if (navigator.userAgent.includes("Windows")) return "windows"
  if (navigator.userAgent.includes("Linux")) return "linux"
  return "unknown"
})()

const [webviewZoom, setWebviewZoom] = createSignal(1)

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

  applyZoom(clampZoomFactor(next))
})

export { webviewZoom }
