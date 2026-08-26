import { describe, expect, test } from "bun:test"

import { createReviewTabActivation } from "./review-tab-activation"

describe("Review workspace tab activation", () => {
  test("captures Review before a direct tab selection is committed", () => {
    let current = "review"
    const events: string[] = []
    const activation = createReviewTabActivation({
      current: () => current,
      reviewTabId: "review",
      captureReview: () => events.push("capture"),
      commit: (id) => {
        events.push(`commit:${id}`)
        current = id
      },
    })

    activation.activate("file:a")

    expect(events).toEqual(["capture", "commit:file:a"])
  })

  test("can prepare before tab insertion and commit only after the body is mounted", () => {
    let current = "review"
    const events: string[] = []
    const activation = createReviewTabActivation({
      current: () => current,
      reviewTabId: "review",
      captureReview: () => events.push("capture"),
      commit: (id) => {
        events.push(`commit:${id}`)
        current = id
      },
    })

    const prepared = activation.prepare("file:new")
    events.push("insert:file:new")
    activation.commit(prepared)

    expect(events).toEqual(["capture", "insert:file:new", "commit:file:new"])
  })

  test("does not capture when Review is not the current tab", () => {
    const events: string[] = []
    const activation = createReviewTabActivation({
      current: () => "file:a",
      reviewTabId: "review",
      captureReview: () => events.push("capture"),
      commit: (id) => events.push(`commit:${id}`),
    })

    activation.activate("file:b")

    expect(events).toEqual(["commit:file:b"])
  })
})
