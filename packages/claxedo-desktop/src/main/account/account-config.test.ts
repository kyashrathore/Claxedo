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

  test("accepts only a typed release-validation operation", () => {
    expect(
      readAccountConfig({
        CLAXEDO_CORE_ORIGIN: "https://core.example",
        CLAXEDO_RELEASE_VALIDATION_OPERATION: "private_session",
      }),
    ).toEqual({
      configured: true,
      coreOrigin: "https://core.example",
      releaseValidationOperation: "private_session",
    })
    expect(
      readAccountConfig({
        CLAXEDO_CORE_ORIGIN: "https://core.example",
        CLAXEDO_RELEASE_VALIDATION_OPERATION: "anything",
      }),
    ).toMatchObject({ configured: false, missing: [expect.stringContaining("not recognized")] })
  })
})

describe("canary journey configuration", () => {
  test("carries an explicit canary journey id", () => {
    expect(
      readAccountConfig({
        CLAXEDO_CORE_ORIGIN: "https://core.example",
        CLAXEDO_RELEASE_CANARY_JOURNEY_ID: " journey-release-1 ",
      }),
    ).toEqual({ configured: true, coreOrigin: "https://core.example", canaryJourneyId: "journey-release-1" })
  })

  test("omits the journey when unset or blank", () => {
    expect(
      readAccountConfig({ CLAXEDO_CORE_ORIGIN: "https://core.example", CLAXEDO_RELEASE_CANARY_JOURNEY_ID: "  " }),
    ).toEqual({ configured: true, coreOrigin: "https://core.example" })
  })
})
