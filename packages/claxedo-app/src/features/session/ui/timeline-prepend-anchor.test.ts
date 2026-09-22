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

  test("revealing the turns behind the previous-messages row keeps the reader on the turn below it", () => {
    let revealed = 0
    const root = document.createElement("div")
    const previous = document.createElement("div")
    previous.dataset.timelineKey = "previous-messages:u5"
    previous.dataset.timelineAnchor = "none"
    const turn = document.createElement("div")
    turn.dataset.timelineKey = "user-message:u5"
    root.append(previous, turn)
    root.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
    previous.getBoundingClientRect = () => new DOMRect(0, -root.scrollTop, 800, 40)
    turn.getBoundingClientRect = () => new DOMRect(0, (revealed || 40) - root.scrollTop, 800, 360)
    const prepend = createTimelinePrependAnchor({
      root: () => root,
      displayed: () => true,
      resolveRowStart: () => undefined,
    })

    prepend.capture()
    previous.remove()
    revealed = 4800
    prepend.restore()
    prepend.settle()

    expect(root.scrollTop).toBe(4760)
  })
})
