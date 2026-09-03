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
    expect(Object.keys(value)).toEqual([
      "CLAXEDO_CORE_ORIGIN",
      "CLAXEDO_RELEASE_VALIDATION_OPERATION",
      "CLAXEDO_RELEASE_CANARY_JOURNEY_ID",
    ])
    expect(JSON.stringify(value)).not.toMatch(/AUTHORIZE|TOKEN_URL|CLIENT_ID|SCOPE|SECRET|BETTER_AUTH/)
  })
})

describe("release phase inputs", () => {
  test("carries the canary journey from runtime or baked configuration", () => {
    // The composer is an allowlist: a phase input missing here is dropped
    // silently, and the build behaves as if the phase were unset.
    expect(
      accountConfigEnvironment({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: " journey-1 " }, {}),
    ).toMatchObject({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-1" })
    expect(
      accountConfigEnvironment({}, { CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-baked" }),
    ).toMatchObject({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-baked" })
    expect(accountConfigEnvironment({}, {}).CLAXEDO_RELEASE_CANARY_JOURNEY_ID).toBeUndefined()
  })
})
