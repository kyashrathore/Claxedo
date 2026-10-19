import { createSignal } from "solid-js"
import { timelineInteractionPlan } from "./timeline-view-state"

const READER_OVERSCAN = 6

export function createTimelineReaderInteraction(input: {
  readonly prepend: { loading(): boolean; settle(): void }
  readonly hasScrollGesture: () => boolean
  readonly expandInitialTurn: () => void
  readonly onReaderToggle: () => void
}) {
  const [overscan, setOverscan] = createSignal(0)
  const raiseOverscan = () => {
    if (overscan() < READER_OVERSCAN) setOverscan(READER_OVERSCAN)
  }
  return {
    overscan,
    toggled: () => {
      raiseOverscan()
      input.onReaderToggle()
    },
    prepareInteractionScroll: () => {
      const plan = timelineInteractionPlan({ prependLoading: input.prepend.loading(), hasScrollGesture: input.hasScrollGesture() })
      if (plan.prepareOverscan) {
        input.expandInitialTurn()
        raiseOverscan()
      }
      if (plan.settlePrependAnchor) input.prepend.settle()
      return plan
    },
  }
}
