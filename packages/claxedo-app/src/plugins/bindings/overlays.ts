import { onCleanup, type Component, type JSX } from "solid-js"
import type { Commands } from "@/shell"

type OverlayView = Component<{ readonly close: () => void }>

export type OverlayTracker = {
  readonly track: (overlayId: string, view: OverlayView) => OverlayView
  readonly open: (overlayId: string) => void
  readonly close: (overlayId: string) => void
}

export function createOverlayTracker(commands: Commands): OverlayTracker {
  const shown = new Map<string, () => void>()
  return {
    track: (overlayId, view) => (props): JSX.Element => {
      shown.set(overlayId, props.close)
      onCleanup(() => shown.delete(overlayId))
      return view(props)
    },
    open: (overlayId) => {
      if (!shown.has(overlayId)) commands.trigger(`overlay.${overlayId}`)
    },
    close: (overlayId) => shown.get(overlayId)?.(),
  }
}
