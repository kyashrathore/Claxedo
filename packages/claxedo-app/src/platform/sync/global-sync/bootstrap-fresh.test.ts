import { describe, expect, test } from "bun:test"
import { shouldInvalidateBootstrapFresh } from "./bootstrap-fresh"

describe("shouldInvalidateBootstrapFresh", () => {
  test("keeps routine session events from forcing another bootstrap", () => {
    expect(shouldInvalidateBootstrapFresh("session.created")).toBe(false)
    expect(shouldInvalidateBootstrapFresh("session.updated")).toBe(false)
    expect(shouldInvalidateBootstrapFresh("message.updated")).toBe(false)
  })

  test("invalidates when the server instance is disposed", () => {
    expect(shouldInvalidateBootstrapFresh("server.instance.disposed")).toBe(true)
  })
})
