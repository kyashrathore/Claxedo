import { beforeEach, describe, expect, test } from "vitest"
import { configureOpenCodeAuth, opencodeHeaders } from "./opencode-auth"

describe("opencodeHeaders", () => {
  beforeEach(() => {
    configureOpenCodeAuth(null)
  })

  test("preserves existing headers when no password is configured", () => {
    const headers = opencodeHeaders({
      "x-opencode-directory": "/tmp/demo",
      "x-workspace-id": "ws_1",
    })

    expect(headers.get("authorization")).toBeNull()
    expect(headers.get("x-opencode-directory")).toBe("/tmp/demo")
    expect(headers.get("x-workspace-id")).toBe("ws_1")
  })

  test("adds basic auth without dropping existing routing headers", () => {
    configureOpenCodeAuth("desk-secret")

    const headers = opencodeHeaders({
      "x-opencode-directory": "/tmp/demo",
      "x-workspace-id": "ws_1",
    })

    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:desk-secret").toString("base64")}`)
    expect(headers.get("x-opencode-directory")).toBe("/tmp/demo")
    expect(headers.get("x-workspace-id")).toBe("ws_1")
  })

  test("does not override an explicit authorization header", () => {
    configureOpenCodeAuth("desk-secret")

    const headers = opencodeHeaders({
      authorization: "Bearer custom",
      "x-opencode-directory": "/tmp/demo",
    })

    expect(headers.get("authorization")).toBe("Bearer custom")
  })
})
