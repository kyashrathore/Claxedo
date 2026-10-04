import { describe, expect, test } from "bun:test"
import { desktopProduct } from "./desktop-product"

describe("desktopProduct", () => {
  test("each channel has its own app id and product name, so profiles and Keychain items never meet", () => {
    const products = (["dev", "beta", "prod"] as const).map(desktopProduct)
    expect(new Set(products.map((product) => product.appId)).size).toBe(3)
    expect(new Set(products.map((product) => product.productName)).size).toBe(3)
    expect(desktopProduct("prod")).toEqual({ appId: "ai.claxedo.desktop", productName: "Claxedo" })
  })
})
