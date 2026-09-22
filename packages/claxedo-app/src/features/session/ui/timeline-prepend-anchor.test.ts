import { describe, expect, test } from "bun:test"
import { createTimelinePrependAnchor } from "./timeline-prepend-anchor"

function scrollingTimeline() {
  let contentAbove = 0
  const root = document.createElement("div")
  const row = document.createElement("div")
  row.dataset.timelineKey = "turn-9"
  root.append(row)
  root.scrollTop = 1000
  root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  row.getBoundingClientRect = () => new DOMRect(0, 1000 + contentAbove - root.scrollTop, 800, 200)
  return {
    root,
    prependHistory: (height: number) => { contentAbove += height },
  }
}

describe("createTimelinePrependAnchor", () => {
  test("a gesture landing before the first restore frame keeps the reader on the row they were reading", () => {
    const timeline = scrollingTimeline()
    const prepend = createTimelinePrependAnchor({
      root: () => timeline.root,
      displayed: () => true,
      resolveRowStart: () => undefined,
    })

    prepend.capture()
    timeline.prependHistory(4800)
    prepend.restore()
    expect(prepend.running()).toBe(true)

    prepend.settle()

    expect(timeline.root.scrollTop).toBe(5800)
    expect(prepend.running()).toBe(false)
  })

  test("settling with no restore pending leaves the reader's offset alone", () => {
    const timeline = scrollingTimeline()
    const prepend = createTimelinePrependAnchor({
      root: () => timeline.root,
      displayed: () => true,
      resolveRowStart: () => undefined,
    })

    timeline.prependHistory(4800)
    prepend.settle()

    expect(timeline.root.scrollTop).toBe(1000)
  })
})
