import { describe, expect, test } from "bun:test"
import { globalShellReady } from "./global-readiness"

describe("global readiness shell-data boundary", () => {
  test("reads readiness from the global sync source", () => {
    expect(globalShellReady({ source: { ready: true } })).toBe(true)
    expect(globalShellReady({ source: { ready: false } })).toBe(false)
  })
})
