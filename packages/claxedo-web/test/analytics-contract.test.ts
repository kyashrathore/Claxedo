import { describe, expect, test } from "bun:test"
import { buildConversionEvent, conversionEventNames, conversionRoute } from "../src/scripts/analytics"

describe("conversion analytics contract", () => {
  test("emits only the bounded conversion events", () => {
    expect(conversionEventNames).toEqual(["open_claxedo", "deploy_cloudflare", "download_app", "explore_framework"])
    expect(buildConversionEvent({ name: "download_app", route: "/download?source=secret", placement: "download-page", platform: "linux-deb", version: "0.0.59" })).toEqual({
      name: "download_app", route: "/download", placement: "download-page", platform: "linux-deb", version: "0.0.59",
    })
  })

  test("rejects arbitrary names, metadata, and malformed placement", () => {
    expect(buildConversionEvent({ name: "prompt", route: "/", placement: "hero" })).toBeUndefined()
    expect(buildConversionEvent({ name: "download_app", route: "/", placement: "free form user data" })).toBeUndefined()
    expect(buildConversionEvent({ name: "download_app", route: "/", placement: "hero", platform: "/Users/person/private" })).toEqual({ name: "download_app", route: "/", placement: "hero" })
    expect(buildConversionEvent({ name: "download_app", route: "/private-repository-name", placement: "hero" })).toBeUndefined()
  })

  test("classifies detail pages without retaining sensitive paths", () => {
    expect(conversionRoute("/framework/cookbook/01-hello-agent")).toBe("/framework")
    expect(conversionRoute("/compare/matrix-os/")).toBe("/compare")
    expect(conversionRoute("/unknown")).toBeUndefined()
  })

})
