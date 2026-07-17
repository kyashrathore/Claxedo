import { describe, expect, test } from "bun:test"
import { selectionSDK } from "./document-tab"

describe("document selection SDK", () => {
  test("propagates provider failures instead of silently disabling selection actions", () => {
    expect(() =>
      selectionSDK(
        "/repo",
        () => {
          throw new Error("Local SDK provider failed")
        },
        () => ({ client: {} }),
      ),
    ).toThrow("Local SDK provider failed")
  })

  test("selects the provider for the document placement", () => {
    expect(
      selectionSDK(
        "/repo",
        () => "local",
        () => "global",
      ),
    ).toBe("local")
    expect(
      selectionSDK(
        undefined,
        () => "local",
        () => "global",
      ),
    ).toBe("global")
  })
})
