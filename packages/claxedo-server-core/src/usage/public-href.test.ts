import { describe, expect, test } from "vitest"
import { publicUsageHref } from "./public-href"

describe("publicUsageHref", () => {
  test("links workspace usage only by opaque workspace ID", () => {
    expect(publicUsageHref("workspace", "ws_123")).toBe("/w/ws_123")
    expect(publicUsageHref("workspace", "/Users/ada/private/repo")).toBeUndefined()
    expect(publicUsageHref("workspace", "%2FUsers%2Fada%2Fprivate%2Frepo")).toBeUndefined()
    expect(publicUsageHref("workspace", "%252FUsers%252Fada%252Fprivate%252Frepo")).toBeUndefined()
  })
})
