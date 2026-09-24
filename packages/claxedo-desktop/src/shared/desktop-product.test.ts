import { describe, expect, test } from "bun:test"
import { desktopProduct, parseDesktopRenderer } from "./desktop-product"

describe("desktopProduct", () => {
  test("the v2 renderer shares neither app id nor product name with any channel of today's app", () => {
    const v2 = desktopProduct("dev", "v2")
    expect(v2).toEqual({ appId: "ai.claxedo.desktop.v2.dev", productName: "Claxedo V2 Dev" })
    for (const channel of ["dev", "beta", "prod"] as const) {
      const today = desktopProduct(channel, "v1")
      expect(today.appId).not.toBe(v2.appId)
      expect(today.productName).not.toBe(v2.productName)
    }
  })

  test("the v2 renderer is refused on the release channels", () => {
    expect(() => desktopProduct("beta", "v2")).toThrow(/dev channel/)
    expect(() => desktopProduct("prod", "v2")).toThrow(/dev channel/)
  })
})

describe("parseDesktopRenderer", () => {
  test("unset means today's renderer and an unknown value is an error", () => {
    expect(parseDesktopRenderer(undefined)).toBe("v1")
    expect(parseDesktopRenderer("")).toBe("v1")
    expect(parseDesktopRenderer("v2")).toBe("v2")
    expect(() => parseDesktopRenderer("V2")).toThrow(/v1 or v2/)
  })
})
