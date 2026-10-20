import { expect, test } from "bun:test"
import { createTimelineReaderInteraction } from "./timeline-reader-interaction"

function reader(loading = false) {
  const calls: string[] = []
  const interaction = createTimelineReaderInteraction({
    prepend: { loading: () => loading, settle: () => calls.push("settle") },
    hasScrollGesture: () => false,
    expandInitialTurn: () => calls.push("expand"),
    onReaderToggle: () => calls.push("toggle"),
  })
  return { interaction, calls }
}

test("a first view renders no overscan, and a fold, tool or group the reader toggles raises it to 6 without expanding the turn", () => {
  const { interaction, calls } = reader()
  expect(interaction.overscan()).toBe(0)
  interaction.toggled()
  expect(interaction.overscan()).toBe(6)
  expect(calls).toEqual(["toggle"])
})

test("a scroll interaction expands the cold final turn, raises the overscan and settles the prepend anchor unless a page is loading", () => {
  const idle = reader()
  idle.interaction.prepareInteractionScroll()
  expect(idle.interaction.overscan()).toBe(6)
  expect(idle.calls).toEqual(["expand", "settle"])
  const loading = reader(true)
  loading.interaction.prepareInteractionScroll()
  expect(loading.calls).toEqual(["expand"])
})
