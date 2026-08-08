import { describe, expect, test } from "bun:test"
import { messageNavFits } from "./message-nav-layout"

describe("message nav layout", () => {
  test("reserves the compact rail beside the responsive timeline column", () => {
    expect(messageNavFits(887, 1200)).toBe(false)
    expect(messageNavFits(888, 1200)).toBe(true)
    expect(messageNavFits(999, 1600)).toBe(false)
    expect(messageNavFits(1000, 1600)).toBe(true)
  })
})
