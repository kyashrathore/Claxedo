import { onCleanup, type JSX } from "solid-js"
import { useShellLayout } from "../layout"
import { SIDEBAR_MIN_WIDTH } from "../store"

export function SidebarGrip(): JSX.Element {
  const layout = useShellLayout()
  let stop: (() => void) | undefined
  const start = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = layout.sidebarWidth()
    const move = (next: PointerEvent) => {
      const width = startWidth + next.clientX - startX
      if (width >= SIDEBAR_MIN_WIDTH) return layout.setSidebarWidth(width)
      layout.send({ type: "hideSidebar" })
      stop?.()
    }
    stop = () => {
      stop = undefined
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
    }
    const end = () => stop?.()
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
    event.preventDefault()
    event.stopPropagation()
  }
  onCleanup(() => stop?.())
  return (
    <div aria-hidden="true" class="max-md:hidden absolute top-0 right-[-4px] bottom-0 w-2 cursor-col-resize z-[90] group" onPointerDown={start}>
      <div class="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-border-base/80 transition-colors duration-100" />
    </div>
  )
}
