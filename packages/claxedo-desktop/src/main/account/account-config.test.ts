import { describe, expect, test } from "bun:test"
import { readAccountConfig } from "./account-config"

describe("readAccountConfig", () => {
  test("accepts only the selected deployment's exact HTTPS origin", () => {
    expect(readAccountConfig({ CLAXEDO_CORE_ORIGIN: "https://core.example" })).toEqual({
      configured: true,
      coreOrigin: "https://core.example",
    })
  })

  test.each([
    undefined,
    "",
    "http://core.example",
    "https://core.example/",
    "https://core.example/path",
    "https://core.example?x=1",
    "https://*.example",
  ])("rejects missing or non-exact origin %p", (value) => {
    expect(readAccountConfig({ CLAXEDO_CORE_ORIGIN: value })).toMatchObject({
      configured: false,
      missing: [expect.stringContaining("exact HTTPS origin")],
    })
  })
})
