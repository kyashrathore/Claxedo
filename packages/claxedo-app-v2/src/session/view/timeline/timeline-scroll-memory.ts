import { createEffect, on } from "solid-js"
import { captureTimelinePrependAnchor, type TimelinePrependAnchor } from "./timeline-prepend-anchor"

export type TimelineScrollPosition = { offset: number; following: boolean; anchor?: TimelinePrependAnchor }

export function createTimelineScrollMemory(input: {
  initial?: TimelineScrollPosition
  active: () => boolean
  root: () => HTMLDivElement | undefined
  following: () => boolean
  hasTarget: () => boolean
  restoring: () => boolean
  restoreFollowing: (following: boolean) => void
  scrollToOffset: (offset: number) => void
  scrollToEnd: () => void
  restoreAnchor: (anchor: TimelinePrependAnchor | undefined) => void
}) {
  let saved = input.initial
  createEffect(on(input.active, (active) => {
    if (!active || !saved || input.hasTarget()) return
    input.restoreFollowing(saved.following)
    if (saved.following) {
      if (input.root()?.clientHeight) input.scrollToEnd()
      return
    }
    input.scrollToOffset(saved.offset)
    input.restoreAnchor(saved.anchor)
  }))
  return {
    snapshot: () => saved,
    capture() {
      const root = input.root()
      if (!input.active() || !root || root.clientHeight === 0 || input.restoring()) return
      saved = {
        offset: root.scrollTop,
        following: input.following(),
        anchor: captureTimelinePrependAnchor(root),
      }
    },
  }
}
