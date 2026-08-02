import { describe, expect, test } from "bun:test"
import { isProjectionCacheKey } from "./keys"

describe("persistence keys", () => {
  test("recognizes workbench and harness projection keys only", () => {
    expect(isProjectionCacheKey("projection:workbench:user:global")).toBe(true)
    expect(isProjectionCacheKey("projection:harness-config:user:workspace")).toBe(true)
    expect(isProjectionCacheKey("projection:other:user:global")).toBe(false)
    expect(isProjectionCacheKey("opencode.global.dat")).toBe(false)
  })
})
