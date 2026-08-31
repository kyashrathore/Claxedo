import { describe, expect, test } from "bun:test"
import { accountConfigEnvironment } from "./public-config"

describe("accountConfigEnvironment", () => {
  test("bakes only the selected core origin", () => {
    expect(accountConfigEnvironment({}, { CLAXEDO_CORE_ORIGIN: "https://core.example" })).toEqual({
      CLAXEDO_CORE_ORIGIN: "https://core.example",
      CLAXEDO_RELEASE_VALIDATION_OPERATION: undefined,
    })
  })

  test("lets a self-built app select its own deployment", () => {
    expect(
      accountConfigEnvironment(
        { CLAXEDO_CORE_ORIGIN: "https://self.example" },
        { CLAXEDO_CORE_ORIGIN: "https://official.example" },
      ),
    ).toEqual({
      CLAXEDO_CORE_ORIGIN: "https://self.example",
      CLAXEDO_RELEASE_VALIDATION_OPERATION: undefined,
    })
  })

  test("contains no provider endpoint, id, scope, or credential inputs", () => {
    const value = accountConfigEnvironment({}, {})
    expect(Object.keys(value)).toEqual(["CLAXEDO_CORE_ORIGIN", "CLAXEDO_RELEASE_VALIDATION_OPERATION"])
    expect(JSON.stringify(value)).not.toMatch(/AUTHORIZE|TOKEN_URL|CLIENT_ID|SCOPE|SECRET|CLERK|BETTER_AUTH/)
  })
})
