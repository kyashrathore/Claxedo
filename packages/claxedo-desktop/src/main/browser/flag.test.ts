import { describe, expect, test } from "bun:test"
import { isBrowserTabEnabled } from "./flag"

describe("isBrowserTabEnabled", () => {
  test("enables browser tabs by default", () => {
    expect(isBrowserTabEnabled({})).toBe(true)
  })

  test("allows an explicit runtime opt-out", () => {
    expect(isBrowserTabEnabled({ CLAXEDO_ENABLE_BROWSER_TAB: "0" })).toBe(false)
  })

  test("keeps the legacy explicit enable value enabled", () => {
    expect(isBrowserTabEnabled({ CLAXEDO_ENABLE_BROWSER_TAB: "1" })).toBe(true)
  })
})
