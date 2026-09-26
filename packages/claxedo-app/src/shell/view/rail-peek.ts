import { onCleanup, onMount } from "solid-js"
import type { ShellLayout } from "../layout"

const HOT_ZONE_WIDTH = 48
const HOT_ZONE_HEIGHT = 48

type RailBox = { readonly top: number; readonly right: number; readonly bottom: number }

export function trackRailPeek(layout: ShellLayout, box: () => RailBox | undefined): void {
  const move = (event: MouseEvent) => {
    if (layout.phone()) return
    if (layout.sidebarPinned()) return layout.unmutePeek()
    if (!layout.sidebarShown()) {
      const inHotZone = event.clientX <= HOT_ZONE_WIDTH && event.clientY <= HOT_ZONE_HEIGHT
      if (inHotZone && !layout.peekMuted()) layout.send({ type: "peekSidebar" })
      if (!inHotZone) layout.unmutePeek()
      return
    }
    const rect = box()
    if (!rect) return
    if (event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) layout.send({ type: "unpeekSidebar" })
  }
  onMount(() => {
    document.addEventListener("mousemove", move)
    onCleanup(() => document.removeEventListener("mousemove", move))
  })
}
