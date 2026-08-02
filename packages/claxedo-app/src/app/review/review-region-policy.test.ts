import { describe, expect, test } from "bun:test"
import { reviewRegionPolicy } from "./review-region-policy"

describe("reviewRegionPolicy", () => {
  test("keeps the first mount unarmed while the workspace is not ready", () => {
    expect(reviewRegionPolicy({ key: "ws\nreview", ready: false })).toEqual({
      key: "ws\nreview",
      armed: false,
      showPending: true,
    })
  })

  test("arms the review region once the workspace is ready", () => {
    expect(reviewRegionPolicy({ key: "ws\nreview", ready: true })).toEqual({
      key: "ws\nreview",
      armed: true,
      showPending: false,
    })
  })

  test("does not disarm the same key during a reconnect", () => {
    expect(reviewRegionPolicy({
      key: "ws\nreview",
      prev: { key: "ws\nreview", armed: true },
      ready: false,
    })).toEqual({
      key: "ws\nreview",
      armed: true,
      showPending: true,
    })
  })

  test("changing keys gates the next review region again", () => {
    expect(reviewRegionPolicy({
      key: "other\nreview",
      prev: { key: "ws\nreview", armed: true },
      ready: false,
    })).toEqual({
      key: "other\nreview",
      armed: false,
      showPending: true,
    })
  })

  test("empty keys do not arm or show pending chrome", () => {
    expect(reviewRegionPolicy({
      prev: { key: "ws\nreview", armed: true },
      ready: false,
    })).toEqual({
      key: undefined,
      armed: false,
      showPending: false,
    })
  })
})
