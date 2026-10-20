import { describe, expect, test } from "bun:test"
import { accountConfigEnvironment } from "./public-config"

describe("accountConfigEnvironment", () => {
  test("bakes only the selected core origin", () => {
    expect(accountConfigEnvironment({}, { CLAXEDO_CORE_ORIGIN: "https://core.example" }, false)).toEqual({
      CLAXEDO_CORE_ORIGIN: "https://core.example",
      CLAXEDO_RELEASE_VALIDATION_OPERATION: undefined,
    })
  })

  test("lets an unpackaged run select its own deployment", () => {
    expect(
      accountConfigEnvironment(
        { CLAXEDO_CORE_ORIGIN: "https://self.example" },
        { CLAXEDO_CORE_ORIGIN: "https://official.example" },
        false,
      ),
    ).toEqual({
      CLAXEDO_CORE_ORIGIN: "https://self.example",
      CLAXEDO_RELEASE_VALIDATION_OPERATION: undefined,
    })
  })

  test("a packaged build keeps its baked core origin whatever its launch environment names", () => {
    const runtime = { CLAXEDO_CORE_ORIGIN: "https://attacker.example" }
    expect(accountConfigEnvironment(runtime, { CLAXEDO_CORE_ORIGIN: "https://official.example" }, true).CLAXEDO_CORE_ORIGIN)
      .toBe("https://official.example")
    expect(accountConfigEnvironment(runtime, {}, true).CLAXEDO_CORE_ORIGIN).toBeUndefined()
  })

  test("contains no provider endpoint, id, scope, or credential inputs", () => {
    const value = accountConfigEnvironment({}, {}, false)
    expect(Object.keys(value)).toEqual([
      "CLAXEDO_CORE_ORIGIN",
      "CLAXEDO_RELEASE_VALIDATION_OPERATION",
      "CLAXEDO_RELEASE_CANARY_JOURNEY_ID",
      "CLAXEDO_RELAY_ORIGINS",
    ])
    expect(JSON.stringify(value)).not.toMatch(/AUTHORIZE|TOKEN_URL|CLIENT_ID|SCOPE|SECRET|BETTER_AUTH/)
  })
})

describe("relay origins", () => {
  test("come from runtime or baked configuration", () => {
    expect(accountConfigEnvironment({ CLAXEDO_RELAY_ORIGINS: "https://self-relay.example" }, { CLAXEDO_RELAY_ORIGINS: "https://relay.example" }, false).CLAXEDO_RELAY_ORIGINS)
      .toBe("https://self-relay.example")
    expect(accountConfigEnvironment({}, { CLAXEDO_RELAY_ORIGINS: "https://relay.example" }, false).CLAXEDO_RELAY_ORIGINS).toBe("https://relay.example")
  })
})

describe("release phase inputs", () => {
  test("carries the canary journey from runtime or baked configuration", () => {
    // The composer is an allowlist: a phase input missing here is dropped
    // silently, and the build behaves as if the phase were unset.
    expect(
      accountConfigEnvironment({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: " journey-1 " }, {}, false),
    ).toMatchObject({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-1" })
    expect(
      accountConfigEnvironment({}, { CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-baked" }, false),
    ).toMatchObject({ CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "journey-baked" })
    expect(accountConfigEnvironment({}, {}, false).CLAXEDO_RELEASE_CANARY_JOURNEY_ID).toBeUndefined()
  })
})
