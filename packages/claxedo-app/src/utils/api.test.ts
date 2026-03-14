import { beforeEach, describe, expect, test } from "bun:test"
import { fixDir, isDemoMode, isDemoPath, isEmbedMode } from "./api"

describe("demo routing", () => {
  beforeEach(() => {
    window.location.href = "http://localhost/"
  })

  test("matches only the demo path prefix", () => {
    expect(isDemoPath("/")).toBe(false)
    expect(isDemoPath("/demo")).toBe(true)
    expect(isDemoPath("/demo/")).toBe(true)
    expect(isDemoPath("/demo/foo")).toBe(true)
    expect(isDemoPath("/foo/demo")).toBe(false)
  })

  test("ignores the old demo query on the live root", () => {
    window.location.href = "http://localhost/?demo=1"
    expect(isDemoMode()).toBe(false)
  })

  test("enables demo mode under /demo", () => {
    window.location.href = "http://localhost/demo/?demo=1"
    expect(isDemoMode()).toBe(true)
  })

  test("keeps embed detection query-based", () => {
    window.location.href = "http://localhost/demo/?embed=1"
    expect(isEmbedMode()).toBe(true)
  })
})

describe("fixDir", () => {
  test("preserves absolute paths", () => {
    expect(fixDir("/Users/yash/project")).toBe("/Users/yash/project")
  })

  test("restores a leading slash for workspace paths", () => {
    expect(fixDir("Users/yash/project")).toBe("/Users/yash/project")
  })

  test("recovers embedded absolute paths from temp prefixes", () => {
    expect(fixDir("tmp/dev/Users/yash/project")).toBe("/Users/yash/project")
  })
})
