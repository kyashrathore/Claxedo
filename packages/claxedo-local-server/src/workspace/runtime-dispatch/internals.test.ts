import { describe, expect, test } from "vitest"
import { embeddedConfigModeForPath } from "./internals"

describe("embedded workspace runtime configuration boundary", () => {
  test("read-only workspace APIs remain available when configuration needs attention", () => {
    expect(embeddedConfigModeForPath("/session", "GET")).toBe("skip")
    expect(embeddedConfigModeForPath("/permission/modes", "GET")).toBe("skip")
    expect(embeddedConfigModeForPath("/session/s1/message", "GET")).toBe("skip")
  })

  test("session mutations still fail closed on configuration replay", () => {
    expect(embeddedConfigModeForPath("/session", "POST")).toBe("sync")
    expect(embeddedConfigModeForPath("/session/s1/message", "POST")).toBe("sync")
  })

  test("transport and filesystem paths never replay configuration", () => {
    expect(embeddedConfigModeForPath("/api/wr/events", "POST")).toBe("skip")
    expect(embeddedConfigModeForPath("/file", "POST")).toBe("skip")
  })
})
